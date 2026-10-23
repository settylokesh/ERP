import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { runAction } from '../src/documents/actions.js';
import { createDocument, createFrom, deleteDocument } from '../src/documents/engine.js';
import { acct } from '../src/ledger.js';
import { createPayment } from '../src/payments.js';
import { saveQualityRule, ensureReceiveInspections, recordInspection } from '../src/manufacturing.js';
import { r2 } from '../src/util.js';
import { bal, cogsOf, doc, fresh, inventoryReconciles, sell, stock, trialBalanced, type Ctx } from './helpers.js';

let c: Ctx;
beforeEach(() => { c = fresh(); });

describe('Procure to pay', () => {
  it('runs purchase request → PO → receive → bill → payment and closes the PO', () => {
    const pr = createDocument('purchase_request', { date: '2026-05-01', lines: [{ item_id: c.widget, qty: 20 }] }, c.admin, { submit: true });
    expect(doc(pr).status).toBe('approved');
    const po = createFrom(pr, 'purchase_order', c.admin, { contact_id: c.vendor, date: '2026-05-02', lines: [{ item_id: c.widget, qty: 20, rate: 90, ref_line_id: db().value('SELECT id FROM document_lines WHERE document_id = ?', pr) }] });
    expect(doc(pr).status).toBe('ordered');
    expect(doc(po).status).toBe('issued');

    const grn = createFrom(po, 'purchase_receive', c.admin, { date: '2026-05-05', lines: [{ item_id: c.widget, qty: 15, ref_line_id: db().value('SELECT id FROM document_lines WHERE document_id = ?', po) }] });
    expect(stock(c.widget)).toBe(15);
    expect(bal('inventory_asset')).toBe(0); // receives move physical stock only
    expect(doc(po).fulfil_status).toBe('partially_received');

    const bill = createFrom(grn, 'bill', c.admin, { date: '2026-05-06' });
    expect(doc(bill)).toMatchObject({ taxable_total: 1350, total: 1593 });
    expect(bal('inventory_asset')).toBe(1350);
    expect(bal('input_cgst') + bal('input_sgst')).toBe(243);
    expect(bal('accounts_payable')).toBe(1593);

    createFrom(po, 'purchase_receive', c.admin, { date: '2026-05-07' });
    createFrom(po, 'bill', c.admin, { date: '2026-05-08' });
    expect(doc(po)).toMatchObject({ fulfil_status: 'received', billing_status: 'billed', status: 'closed' });
    createPayment({ kind: 'made', date: '2026-05-10', contact_id: c.vendor, amount: 1593, account_id: c.bank, allocations: [{ document_id: bill, amount: 1593 }] }, c.admin);
    expect(doc(bill).status).toBe('paid');
    expect(trialBalanced()).toBe(true);
    expect(inventoryReconciles()).toBe(true);
  });

  it('capitalises landed costs into stock value', () => {
    const b = createDocument('bill', {
      date: '2026-05-01', contact_id: c.vendorUp, warehouse_id: c.wh,
      lines: [{ item_id: c.widget, qty: 10, rate: 100, tax_id: c.tax18 }, { account_id: acct('freight_inward'), description: 'Freight', qty: 1, rate: 200, tax_id: c.tax18, data: { landed_cost: true } }],
    }, c.admin, { submit: true });
    expect(doc(b)).toMatchObject({ igst_total: 216, total: 1416 });
    expect(bal('inventory_asset')).toBe(1200); // 1000 goods + 200 freight
    expect(bal('freight_inward')).toBe(0);
    expect(bal('input_igst')).toBe(216);
    expect(inventoryReconciles()).toBe(true);
  });

  it('books reverse charge tax as both ITC and liability', () => {
    const b = createDocument('bill', { date: '2026-05-01', contact_id: c.vendor, reverse_charge: true, lines: [{ account_id: acct('freight_inward'), qty: 1, rate: 1000, tax_id: c.tax5 }] }, c.admin, { submit: true });
    expect(doc(b)).toMatchObject({ total: 1000, cgst_total: 25, sgst_total: 25 });
    expect(bal('accounts_payable')).toBe(1000);
    expect(bal('rcm_payable')).toBe(50);
    expect(bal('input_cgst')).toBe(25);
  });

  it('deducts TDS from the vendor payable', () => {
    const sec = db().value<number>("SELECT id FROM tds_sections WHERE section = '194J' AND rate = 10");
    const b = createDocument('bill', { date: '2026-05-01', contact_id: c.vendor, data: { tds_section_id: sec }, lines: [{ account_id: acct('professional_fees'), qty: 1, rate: 50000, tax_id: c.tax18 }] }, c.admin, { submit: true });
    expect(doc(b)).toMatchObject({ tds_amount: 5000, total: 54000 });
    expect(bal('tds_payable')).toBe(5000);
    expect(bal('professional_fees')).toBe(50000);
  });

  it('expenses ineligible ITC into cost', () => {
    createDocument('bill', { date: '2026-05-01', contact_id: c.vendor, lines: [{ account_id: acct('travel'), qty: 1, rate: 1000, tax_id: c.tax5, itc_eligible: false }] }, c.admin, { submit: true });
    expect(bal('travel')).toBe(1050);
    expect(bal('input_cgst')).toBe(0);
  });

  it('records direct expenses against the paid-through account', () => {
    createDocument('expense', { date: '2026-05-01', data: { paid_through_account_id: c.bank }, lines: [{ account_id: acct('office_supplies'), qty: 1, rate: 500, tax_id: c.tax18 }] }, c.admin, { submit: true });
    expect(bal('office_supplies')).toBe(500);
    expect(db().value('SELECT SUM(credit) FROM journal_lines WHERE account_id = ?', c.bank)).toBe(590);
  });

  it('returns goods to vendors with vendor credits at FIFO cost', () => {
    const b = createDocument('bill', { date: '2026-05-01', contact_id: c.vendor, lines: [{ item_id: c.widget, qty: 10, rate: 100, tax_id: c.tax18 }] }, c.admin, { submit: true });
    const line = db().get('SELECT * FROM document_lines WHERE document_id = ?', b);
    createDocument('vendor_credit', { date: '2026-05-03', contact_id: c.vendor, ref_doc_id: b, lines: [{ item_id: c.widget, qty: 2, rate: 100, tax_id: c.tax18, ref_line_id: line.id }] }, c.admin, { submit: true });
    expect(stock(c.widget)).toBe(8);
    expect(bal('inventory_asset')).toBe(800);
    expect(bal('accounts_payable')).toBe(1180 - 236);
    expect(trialBalanced()).toBe(true);
  });

  it('lets vendor credits correct price without moving stock', () => {
    const b = createDocument('bill', { date: '2026-05-01', contact_id: c.vendor, lines: [{ item_id: c.widget, qty: 10, rate: 100, tax_id: c.tax18 }] }, c.admin, { submit: true });
    const line = db().get('SELECT * FROM document_lines WHERE document_id = ?', b);
    createDocument('vendor_credit', { date: '2026-05-03', contact_id: c.vendor, ref_doc_id: b, lines: [{ item_id: c.widget, qty: 10, rate: 5, tax_id: c.tax18, ref_line_id: line.id, data: { return_to_stock: false } }] }, c.admin, { submit: true });
    expect(stock(c.widget)).toBe(10);
    // All ten units are still in stock, so the whole ₹50 reduction lowers their cost.
    expect(bal('inventory_asset')).toBe(950);
    expect(bal('accounts_payable')).toBe(1180 - 59);
    // A later sale is costed at the corrected price.
    const inv = sell(c, 2, 200, '2026-05-04');
    expect(cogsOf(inv)).toBe(190);
    // The price correction does not use up the billed quantity: the goods can still be returned.
    createDocument('vendor_credit', { date: '2026-05-05', contact_id: c.vendor, ref_doc_id: b, lines: [{ item_id: c.widget, qty: 8, rate: 95, tax_id: c.tax18, ref_line_id: line.id }] }, c.admin, { submit: true });
    expect(stock(c.widget)).toBe(0);
    expect(bal('inventory_asset')).toBe(0);
    expect(trialBalanced()).toBe(true);
  });

  it('books price corrections on goods already sold to cost of goods sold', () => {
    const b = createDocument('bill', { date: '2026-05-01', contact_id: c.vendor, lines: [{ item_id: c.widget, qty: 10, rate: 100, tax_id: c.tax18 }] }, c.admin, { submit: true });
    sell(c, 6, 200, '2026-05-02');
    const line = db().get('SELECT * FROM document_lines WHERE document_id = ?', b);
    const cogsBefore = bal('cogs');
    createDocument('vendor_credit', { date: '2026-05-03', contact_id: c.vendor, ref_doc_id: b, lines: [{ item_id: c.widget, qty: 10, rate: 5, tax_id: c.tax18, ref_line_id: line.id, data: { return_to_stock: false } }] }, c.admin, { submit: true });
    // 4 of 10 units remain: ₹20 reduces inventory, ₹30 reduces cost of goods sold.
    expect(bal('inventory_asset')).toBe(400 - 20);
    expect(r2(cogsBefore - bal('cogs'))).toBe(30);
    expect(trialBalanced()).toBe(true);
  });

  it('limits price corrections to the billed quantity', () => {
    const b = createDocument('bill', { date: '2026-05-01', contact_id: c.vendor, lines: [{ item_id: c.widget, qty: 10, rate: 100, tax_id: c.tax18 }] }, c.admin, { submit: true });
    const line = db().get<any>('SELECT * FROM document_lines WHERE document_id = ?', b);
    const correct = (qty: number) => createDocument('vendor_credit', { date: '2026-05-03', contact_id: c.vendor, ref_doc_id: b, lines: [{ item_id: c.widget, qty, rate: 5, tax_id: c.tax18, ref_line_id: line.id, data: { return_to_stock: false } }] }, c.admin, { submit: true });
    correct(6);
    expect(() => correct(5)).toThrow(/at most 4 more unit/);
    expect(() => correct(4)).not.toThrow();
  });

  it('books the whole price correction to cost of goods sold once every unit is sold', () => {
    const b = createDocument('bill', { date: '2026-05-01', contact_id: c.vendor, lines: [{ item_id: c.widget, qty: 10, rate: 100, tax_id: c.tax18 }] }, c.admin, { submit: true });
    sell(c, 10, 200, '2026-05-02');
    const line = db().get('SELECT * FROM document_lines WHERE document_id = ?', b);
    const cogsBefore = bal('cogs'), purchasesBefore = bal('purchases');
    createDocument('vendor_credit', { date: '2026-05-03', contact_id: c.vendor, ref_doc_id: b, lines: [{ item_id: c.widget, qty: 10, rate: 5, tax_id: c.tax18, ref_line_id: line.id, data: { return_to_stock: false } }] }, c.admin, { submit: true });
    expect(r2(cogsBefore - bal('cogs'))).toBe(50);
    expect(bal('purchases')).toBe(purchasesBefore);
    expect(bal('inventory_asset')).toBe(0);
    expect(trialBalanced()).toBe(true);
  });

  it('holds stock from receives that need quality inspection', () => {
    saveQualityRule({ item_id: c.widget, applies_to: 'purchase_receive', parameters: [{ name: 'Visual', type: 'pass_fail' }] });
    const po = createDocument('purchase_order', { date: '2026-05-01', contact_id: c.vendor, lines: [{ item_id: c.widget, qty: 10, rate: 100 }] }, c.admin, { submit: true });
    const grn = createFrom(po, 'purchase_receive', c.admin, { date: '2026-05-02' });
    expect(doc(grn).status).toBe('pending_inspection');
    expect(stock(c.widget)).toBe(0);
    ensureReceiveInspections(grn, c.admin);
    const qi = db().value<number>("SELECT id FROM quality_inspections WHERE source_id = ?", grn);
    recordInspection(qi, { accepted_qty: 9, rejected_qty: 1, results: [{ parameter: 'Visual', pass: true }] }, c.admin);
    expect(doc(grn).status).toBe('received');
    expect(stock(c.widget)).toBe(9);
  });

  it('only records inspections for receives still awaiting inspection', () => {
    saveQualityRule({ item_id: c.widget, applies_to: 'purchase_receive', parameters: [{ name: 'Visual', type: 'pass_fail' }] });
    const po = createDocument('purchase_order', { date: '2026-05-01', contact_id: c.vendor, lines: [{ item_id: c.widget, qty: 10, rate: 100 }] }, c.admin, { submit: true });
    const grn = createFrom(po, 'purchase_receive', c.admin, { date: '2026-05-02' });
    ensureReceiveInspections(grn, c.admin);
    const qi = db().value<number>("SELECT id FROM quality_inspections WHERE source_id = ?", grn);
    db().run("UPDATE documents SET status = 'received' WHERE id = ?", grn);
    expect(() => recordInspection(qi, { accepted_qty: 10, rejected_qty: 0 }, c.admin)).toThrow(/no longer awaiting inspection/);
    db().run("UPDATE documents SET status = 'pending_inspection' WHERE id = ?", grn);
    deleteDocument(grn, c.admin);
    expect(db().value<number>('SELECT COUNT(*) FROM quality_inspections WHERE source_id = ?', grn)).toBe(0);
    expect(stock(c.widget)).toBe(0);
  });
});

describe('RFQ', () => {
  it('collects bids, awards the lowest bid and creates purchase orders per vendor', () => {
    const rfq = createDocument('rfq', { date: '2026-05-01', due_date: '2099-01-01', data: { vendor_ids: [c.vendor, c.vendorUp] }, lines: [{ item_id: c.widget, qty: 100 }, { item_id: c.service, qty: 1 }] }, c.admin);
    runAction(rfq, 'publish', {}, c.admin);
    const [l1, l2] = db().all('SELECT id FROM document_lines WHERE document_id = ? ORDER BY line_no', rfq);
    runAction(rfq, 'record_bid', { vendor_id: c.vendor, bids: [{ line_id: l1.id, rate: 95 }, { line_id: l2.id, rate: 900 }] }, c.admin);
    runAction(rfq, 'record_bid', { vendor_id: c.vendorUp, bids: [{ line_id: l1.id, rate: 92 }, { line_id: l2.id, rate: 950 }] }, c.admin);
    expect(() => runAction(rfq, 'record_bid', { vendor_id: c.cust, bids: [{ line_id: l1.id, rate: 1 }] }, c.admin)).toThrow(/not invited/);
    runAction(rfq, 'award', { lowest: true }, c.admin);
    const r = runAction(rfq, 'create_pos', {}, c.admin);
    const pos = (r.result as any).created as number[];
    expect(pos).toHaveLength(2);
    const upPo = pos.map(doc).find((p) => p.contact_id === c.vendorUp)!;
    expect(db().value('SELECT rate FROM document_lines WHERE document_id = ?', upPo.id)).toBe(92);
    expect(doc(rfq).status).toBe('ordered');
  });
});
