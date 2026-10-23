import { beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isPrivateAddress, postWebhook } from '../src/activity.js';
import { changePassword, login, resetLoginThrottle } from '../src/auth.js';
import { importStatement, matchLine, matchSuggestions, statementLines } from '../src/banking.js';
import { saveCustomModule, saveCustomRecord, deleteCustomRecord } from '../src/custom.js';
import { db } from '../src/db.js';
import { runAction } from '../src/documents/actions.js';
import { createDocument, createFrom, deleteDocument, voidDocument } from '../src/documents/engine.js';
import { committedQty, incomingQty } from '../src/inventory.js';
import { createPayment, updatePayment } from '../src/payments.js';
import { createPayRun, getPayRun, saveEmployee } from '../src/payroll.js';
import { runRecurring, saveRecurring } from '../src/dashboard.js';
import { saveItem } from '../src/masters.js';
import { nextNumber } from '../src/settings.js';
import { buy, doc, fresh, sell, type Ctx } from './helpers.js';

let c: Ctx;
beforeEach(() => { c = fresh(); });

describe('Numbering', () => {
  it('skips numbers that are already used when the counter is moved back', () => {
    const a = sell(c, 0.5, 100, '2026-05-01', c.service);
    const b = sell(c, 0.5, 100, '2026-05-01', c.service);
    db().run("UPDATE sequences SET next_no = 1 WHERE type = 'invoice'");
    expect(nextNumber('invoice')).toBe('INV-00003');
    expect([doc(a).number, doc(b).number]).toEqual(['INV-00001', 'INV-00002']);
  });

  it('never repeats custom record numbers after a deletion', () => {
    saveCustomModule({ key: 'visits', name: 'Visit', prefix: 'VIS-', fields: [{ key: 'note', label: 'Note', type: 'text' }] }, c.admin);
    const r1 = saveCustomRecord('visits', { note: 'a' }, c.admin);
    const r2 = saveCustomRecord('visits', { note: 'b' }, c.admin);
    deleteCustomRecord('visits', r1, c.admin);
    const r3 = saveCustomRecord('visits', { note: 'c' }, c.admin);
    const numbers = db().all<{ number: string }>('SELECT number FROM custom_records WHERE id IN (?, ?) ORDER BY id', r2, r3).map((r) => r.number);
    expect(numbers).toEqual(['VIS-00002', 'VIS-00003']);
  });
});

describe('Duplicate protection', () => {
  it('refuses the same vendor bill number twice for one vendor', () => {
    buy(c, 1, 100, '2026-05-01', c.widget, { reference: 'V-INV-77' });
    expect(() => buy(c, 1, 100, '2026-05-02', c.widget, { reference: 'v-inv-77' })).toThrow(/already records vendor bill number/);
    // Another vendor may use the same number.
    expect(() => createDocument('bill', { date: '2026-05-02', contact_id: c.vendorUp, reference: 'V-INV-77', lines: [{ item_id: c.widget, qty: 1, rate: 100 }] }, c.admin, { submit: true })).not.toThrow();
  });

  it('allows several partial bills against one purchase order', () => {
    const po = createDocument('purchase_order', { date: '2026-05-01', contact_id: c.vendor, warehouse_id: c.wh, lines: [{ item_id: c.widget, qty: 10, rate: 100 }] }, c.admin, { submit: true });
    const line = db().value<number>('SELECT id FROM document_lines WHERE document_id = ?', po);
    const b1 = createFrom(po, 'bill', c.admin, { date: '2026-05-02', lines: [{ item_id: c.widget, qty: 4, rate: 100, ref_line_id: line }] });
    const b2 = createFrom(po, 'bill', c.admin, { date: '2026-05-03' });
    expect(doc(b1).reference).toBeNull();
    expect(db().value<number>('SELECT qty FROM document_lines WHERE document_id = ?', b2)).toBe(6);
  });
});

describe('Item codes', () => {
  it('validates HSN codes when set or changed, but lets older items be edited', () => {
    expect(() => saveItem({ name: 'Bolt', hsn_code: '73181' })).toThrow(/4, 6 or 8 digits/);
    db().run("UPDATE items SET hsn_code = '84131' WHERE id = ?", c.widget);
    expect(() => saveItem({ name: 'Widget', hsn_code: '84131', sales_rate: 250 }, c.admin, c.widget)).not.toThrow();
    expect(() => saveItem({ name: 'Widget', hsn_code: '84132' }, c.admin, c.widget)).toThrow(/4, 6 or 8 digits/);
  });
});

describe('Stock commitments', () => {
  it('releases committed stock when a delivery challan ships against the order', () => {
    buy(c, 20, 100, '2026-05-01');
    const so = createDocument('sales_order', { date: '2026-05-02', contact_id: c.cust, warehouse_id: c.wh, lines: [{ item_id: c.widget, qty: 8, rate: 200 }] }, c.admin, { submit: true });
    expect(committedQty(c.widget)).toBe(8);
    const line = db().value<number>('SELECT id FROM document_lines WHERE document_id = ?', so);
    createDocument('delivery_challan', { date: '2026-05-03', contact_id: c.cust, ref_doc_id: so, warehouse_id: c.wh, data: { challan_type: 'Supply on Approval' }, lines: [{ item_id: c.widget, qty: 5, rate: 200, ref_line_id: line }] }, c.admin, { submit: true });
    expect(committedQty(c.widget)).toBe(3);
  });

  it('treats rejected receive quantity as still to come and validates it', () => {
    const po = createDocument('purchase_order', { date: '2026-05-01', contact_id: c.vendor, warehouse_id: c.wh, lines: [{ item_id: c.widget, qty: 10, rate: 100 }] }, c.admin, { submit: true });
    const line = db().value<number>('SELECT id FROM document_lines WHERE document_id = ?', po);
    expect(() => createDocument('purchase_receive', { date: '2026-05-02', contact_id: c.vendor, ref_doc_id: po, lines: [{ item_id: c.widget, qty: 10, qty2: 12, ref_line_id: line }] }, c.admin)).toThrow(/accepted quantity/);
    createDocument('purchase_receive', { date: '2026-05-02', contact_id: c.vendor, ref_doc_id: po, lines: [{ item_id: c.widget, qty: 10, qty2: 7, ref_line_id: line }] }, c.admin);
    expect(incomingQty(c.widget)).toBe(3);
    // The rejected 3 can be received again against the same order.
    expect(() => createFrom(po, 'purchase_receive', c.admin, { date: '2026-05-05' })).not.toThrow();
    expect(incomingQty(c.widget)).toBe(0);
  });
});

describe('Document status rules', () => {
  it('only marks a sales return credited by an issued credit note', () => {
    buy(c, 5, 100, '2026-04-30');
    const inv = sell(c, 2, 200, '2026-05-01', c.widget);
    const ret = createFrom(inv, 'sales_return', c.admin, { date: '2026-05-03' });
    runAction(ret, 'receive_return', { date: '2026-05-04' }, c.admin);
    const draftCn = createFrom(ret, 'credit_note', c.admin, { date: '2026-05-05' }, false);
    expect(doc(ret).status).toBe('received');
    deleteDocument(draftCn, c.admin);
    createFrom(ret, 'credit_note', c.admin, { date: '2026-05-05' });
    expect(doc(ret).status).toBe('credited');
  });

  it('explains how to close a sales order with shipments instead of voiding it', () => {
    buy(c, 10, 100, '2026-05-01');
    const so = createDocument('sales_order', { date: '2026-05-02', contact_id: c.cust, warehouse_id: c.wh, lines: [{ item_id: c.widget, qty: 2, rate: 200 }] }, c.admin, { submit: true });
    createFrom(so, 'package', c.admin, { date: '2026-05-03' });
    expect(() => voidDocument(so, c.admin)).toThrow(/Close the order instead/);
  });
});

describe('Vendor credit price corrections', () => {
  it('do not revalue unrelated stock bought after the corrected units were sold', () => {
    const b = buy(c, 10, 100, '2026-05-01');
    sell(c, 10, 200, '2026-05-02');
    createDocument('bill', { date: '2026-05-03', contact_id: c.vendorUp, warehouse_id: c.wh, lines: [{ item_id: c.widget, qty: 50, rate: 100 }] }, c.admin, { submit: true });
    const line = db().value<number>('SELECT id FROM document_lines WHERE document_id = ?', b);
    createDocument('vendor_credit', { date: '2026-05-04', contact_id: c.vendor, ref_doc_id: b, lines: [{ item_id: c.widget, qty: 10, rate: 5, ref_line_id: line, data: { return_to_stock: false } }] }, c.admin, { submit: true });
    // All ten corrected units were already sold, so the ₹50 goes to cost of goods sold and the 50 new units keep their cost.
    expect(db().value('SELECT ROUND(SUM(value), 2) FROM stock_moves WHERE item_id = ? AND accounting = 1', c.widget)).toBe(5000);
    expect(() => createDocument('vendor_credit', { date: '2026-05-04', contact_id: c.vendor, ref_doc_id: b, lines: [{ item_id: c.widget, qty: 1, rate: 1, ref_line_id: line, data: { return_to_stock: false } }] }, c.admin, { submit: true })).toThrow(/at most 0 more/);
  });
});

describe('Bank statement matches', () => {
  it('releases a matched statement line when the payment no longer matches it', () => {
    const inv = createDocument('invoice', { date: '2026-05-01', contact_id: c.cust, lines: [{ item_id: c.service, qty: 1, rate: 1000, tax_id: c.tax18 }] }, c.admin, { submit: true });
    const pid = createPayment({ kind: 'received', date: '2026-05-05', contact_id: c.cust, amount: 1180, account_id: c.bank, allocations: [{ document_id: inv, amount: 1180 }] }, c.admin);
    importStatement(c.bank, 'Date,Description,Deposit,Withdrawal\n2026-05-05,NEFT KA CUSTOMER,1180,', c.admin);
    const line = statementLines(c.bank)[0];
    const s = matchSuggestions(line.id)[0];
    matchLine(line.id, s.source_type, s.source_id, c.admin);
    expect(statementLines(c.bank)[0].status).toBe('matched');
    updatePayment(pid, { kind: 'received', date: '2026-05-05', contact_id: c.cust, amount: 1000, account_id: c.bank, allocations: [{ document_id: inv, amount: 1000 }] }, c.admin);
    expect(statementLines(c.bank)[0]).toMatchObject({ status: 'uncategorized', matched_source_id: null });
  });
});

describe('Payments in foreign currency', () => {
  it('refuses to settle an invoice in a different currency', () => {
    const usd = createDocument('invoice', { date: '2026-05-01', contact_id: c.cust, currency_code: 'USD', exchange_rate: 83, lines: [{ item_id: c.service, qty: 1, rate: 100 }] }, c.admin, { submit: true });
    expect(() => createPayment({ kind: 'received', date: '2026-05-02', contact_id: c.cust, amount: 100, currency_code: 'INR', account_id: c.bank, allocations: [{ document_id: usd, amount: 100 }] }, c.admin)).toThrow(/same currency/);
    // Without an explicit currency the payment follows the invoice.
    const pid = createPayment({ kind: 'received', date: '2026-05-02', contact_id: c.cust, amount: 100, exchange_rate: 84, account_id: c.bank, allocations: [{ document_id: usd, amount: 100 }] }, c.admin);
    expect(db().value('SELECT currency_code FROM payments WHERE id = ?', pid)).toBe('USD');
  });

  it('keeps payments recorded before the currency rule editable', () => {
    const usd = createDocument('invoice', { date: '2026-05-01', contact_id: c.cust, currency_code: 'USD', exchange_rate: 83, lines: [{ item_id: c.service, qty: 1, rate: 100 }] }, c.admin, { submit: true });
    const pid = createPayment({ kind: 'received', date: '2026-05-02', contact_id: c.cust, amount: 50, currency_code: 'USD', account_id: c.bank, allocations: [{ document_id: usd, amount: 50 }] }, c.admin);
    db().run("UPDATE payments SET currency_code = 'INR', exchange_rate = 1 WHERE id = ?", pid); // as an older version stored it
    const edit = { kind: 'received' as const, date: '2026-05-02', contact_id: c.cust, amount: 50, currency_code: 'INR', account_id: c.bank, notes: 'edited', allocations: [{ document_id: usd, amount: 50 }] };
    expect(() => updatePayment(pid, edit, c.admin)).not.toThrow();
    const usd2 = createDocument('invoice', { date: '2026-05-01', contact_id: c.cust, currency_code: 'USD', exchange_rate: 83, lines: [{ item_id: c.service, qty: 1, rate: 100 }] }, c.admin, { submit: true });
    expect(() => updatePayment(pid, { ...edit, amount: 60, allocations: [...edit.allocations, { document_id: usd2, amount: 10 }] }, c.admin)).toThrow(/same currency/);
  });
});

describe('Payroll TDS projection', () => {
  it('uses opening year-to-date salary and TDS when payroll starts mid-year', () => {
    const base = { name: 'X', doj: '2024-01-01', annual_ctc: 2400000, work_state: '29' };
    saveEmployee({ ...base, emp_code: 'A1' });
    saveEmployee({ ...base, emp_code: 'A2', ytd_fy: '2026-27', ytd_gross: 1000000, ytd_tds: 120000 });
    const run = getPayRun(createPayRun({ period: '2026-10' }, c.admin));
    const tds = (code: string) => run.payslips.find((p: any) => p.emp_code === code).extra.tds;
    // A1 is assumed to have earned the current salary since April with no TDS deducted yet, so more is due each month.
    expect(tds('A1')).toBeGreaterThan(tds('A2'));
    expect(tds('A2')).toBeGreaterThan(0);
  });

  it('processes pay runs in order', () => {
    saveEmployee({ emp_code: 'B1', name: 'Y', doj: '2024-01-01', annual_ctc: 600000, work_state: '29' });
    createPayRun({ period: '2026-10' }, c.admin);
    expect(() => createPayRun({ period: '2026-09' }, c.admin)).toThrow(/processed in order/);
  });
});

describe('Recurring invoices', () => {
  it('stops a failing profile and alerts administrators once', () => {
    const ok = saveRecurring({ contact_id: c.cust, frequency: 'monthly', start_date: '2026-05-01', template: { lines: [{ item_id: c.service, qty: 1, rate: 100 }] } });
    const bad = saveRecurring({ contact_id: c.cust, frequency: 'monthly', start_date: '2026-05-01', template: { lines: [{ item_id: 999999, qty: 1, rate: 100 }] } });
    expect(runRecurring('2026-06-15', c.admin)).toHaveLength(2);
    const status = (pid: number) => db().value<string>('SELECT status FROM recurring_profiles WHERE id = ?', pid);
    expect([status(ok), status(bad)]).toEqual(['active', 'stopped']);
    const alerts = () => db().value<number>("SELECT COUNT(*) FROM notifications WHERE title LIKE 'Recurring invoice%'");
    expect(alerts()).toBe(1);
    runRecurring('2026-07-15', c.admin);
    expect(alerts()).toBe(1);
  });
});

describe('Sign-in throttling', () => {
  it('limits guesses per account across addresses and per address across accounts', () => {
    resetLoginThrottle();
    // 30 wrong guesses spread over 30 addresses lock the account everywhere.
    for (let i = 0; i < 30; i++) expect(() => login('admin@example.com', 'wrong', `198.51.100.${i}`)).toThrow(/Invalid/);
    expect(() => login('admin@example.com', 'admin-pass-123', '203.0.113.50')).toThrow(/Too many/);
    resetLoginThrottle();
    // One address trying 100 different accounts is blocked, even for a correct password.
    for (let i = 0; i < 100; i++) expect(() => login(`user${i}@example.com`, 'wrong', '192.0.2.7')).toThrow(/Invalid/);
    expect(() => login('admin@example.com', 'admin-pass-123', '192.0.2.7')).toThrow(/Too many/);
    expect(login('admin@example.com', 'admin-pass-123', '192.0.2.8').token).toMatch(/^[0-9a-f]{64}$/);
    resetLoginThrottle();
  });

  it('does not lock out users who already signed in from a shared address', () => {
    resetLoginThrottle();
    login('admin@example.com', 'admin-pass-123', '192.0.2.20');
    for (let i = 0; i < 100; i++) expect(() => login(`user${i}@example.com`, 'wrong', '192.0.2.20')).toThrow(/Invalid/);
    expect(login('admin@example.com', 'admin-pass-123', '192.0.2.20').token).toMatch(/^[0-9a-f]{64}$/);
    resetLoginThrottle();
  });

  it('limits wrong current-password guesses when changing the password', () => {
    resetLoginThrottle();
    const { token } = login('admin@example.com', 'admin-pass-123', '192.0.2.30');
    for (let i = 0; i < 8; i++) expect(() => changePassword(c.admin.id, 'wrong', 'new-pass-456', token)).toThrow(/incorrect/);
    expect(() => changePassword(c.admin.id, 'admin-pass-123', 'new-pass-456', token)).toThrow(/Too many/);
    resetLoginThrottle();
    changePassword(c.admin.id, 'admin-pass-123', 'new-pass-456', token);
    expect(login('admin@example.com', 'new-pass-456', '192.0.2.30').token).toMatch(/^[0-9a-f]{64}$/);
    resetLoginThrottle();
  });
});

describe('Webhook targets', () => {
  it('recognises private and local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['::ffff:7f00:1', '::127.0.0.1', '64:ff9b::a00:1', '64:ff9b:1::1', '2002:a9fe:a9fe::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'fe80::1%eth0', '198.18.0.1', '192.0.0.170', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '203.0.113.10', '2606:4700::1111', '64:ff9b::808:808', '2002:808:808::1', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('checks the address actually connected to, including names that resolve to local addresses', async () => {
    const server = createServer((_req, res) => res.writeHead(204).end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(postWebhook(`http://127.0.0.1:${port}/hook`, '{}')).rejects.toThrow(/private or local/);
      await expect(postWebhook(`http://[::ffff:127.0.0.1]:${port}/hook`, '{}')).rejects.toThrow(/private or local/);
      await expect(postWebhook(`http://localhost:${port}/hook`, '{}')).rejects.toThrow(/private or local/);
      await expect(postWebhook(`ftp://localhost:${port}/hook`, '{}')).rejects.toThrow(/only http/);
      process.env.WEBHOOK_ALLOW_PRIVATE = '1';
      await expect(postWebhook(`http://127.0.0.1:${port}/hook`, '{}')).resolves.toBe(204);
    } finally {
      delete process.env.WEBHOOK_ALLOW_PRIVATE;
      server.close();
    }
  });
});
