import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { runAction } from '../src/documents/actions.js';
import { convertDraft, createDocument, createFrom, deleteDocument, getDocument, updateDocument, voidDocument } from '../src/documents/engine.js';
import { einvoicePayload, ewaybillPayload } from '../src/einvoice.js';
import { applyCredits, createPayment, createRefund, deletePayment, paymentUnused } from '../src/payments.js';
import { setKv, getKv, DEFAULT_ORG } from '../src/settings.js';
import { bal, buy, doc, fresh, inventoryReconciles, sell, stock, trialBalanced, type Ctx } from './helpers.js';

let c: Ctx;
beforeEach(() => { c = fresh(); buy(c, 50, 100, '2026-04-05'); });

describe('Invoices', () => {
  it('posts AR, sales, CGST/SGST and COGS for an intra-state invoice', () => {
    const inv = sell(c, 5, 200, '2026-05-01');
    const d = doc(inv);
    expect(d).toMatchObject({ taxable_total: 1000, cgst_total: 90, sgst_total: 90, igst_total: 0, total: 1180, balance: 1180, status: 'open' });
    expect(bal('accounts_receivable')).toBe(1180);
    expect(bal('sales')).toBe(1000);
    expect(bal('output_cgst')).toBe(90);
    expect(bal('output_sgst')).toBe(90);
    expect(bal('cogs')).toBe(500);
    expect(d.due_date).toBe('2026-05-31'); // 30-day terms from the customer
    expect(trialBalanced()).toBe(true);
  });

  it('charges IGST for inter-state customers', () => {
    const inv = createDocument('invoice', { date: '2026-05-01', contact_id: c.custMh, lines: [{ item_id: c.service, qty: 1, rate: 1000, tax_id: c.tax18 }] }, c.admin, { submit: true });
    expect(doc(inv)).toMatchObject({ igst_total: 180, cgst_total: 0, place_of_supply: '27', total: 1180 });
    expect(bal('output_igst')).toBe(180);
  });

  it('keeps drafts out of the ledger and stock', () => {
    const inv = createDocument('invoice', { date: '2026-05-01', contact_id: c.cust, lines: [{ item_id: c.widget, qty: 5, rate: 200 }] }, c.admin);
    expect(doc(inv).status).toBe('draft');
    expect(bal('accounts_receivable')).toBe(0);
    expect(stock(c.widget)).toBe(50);
    runAction(inv, 'submit', {}, c.admin);
    expect(bal('accounts_receivable')).toBe(1180);
    expect(stock(c.widget)).toBe(45);
  });

  it('applies rounding adjustments and tax-inclusive pricing', () => {
    const inv = createDocument('invoice', { date: '2026-05-01', contact_id: c.cust, tax_inclusive: true, adjustment: -0.5, lines: [{ item_id: c.service, qty: 1, rate: 1180.5, tax_id: c.tax18 }] }, c.admin, { submit: true });
    const d = doc(inv);
    expect(d.taxable_total).toBe(1000.42);
    expect(d.total).toBe(r(d.taxable_total + d.tax_total - 0.5));
    expect(trialBalanced()).toBe(true);
  });

  it('voids an unpaid invoice and restores stock', () => {
    const inv = sell(c, 5, 200, '2026-05-01');
    voidDocument(inv, c.admin, 'Wrong customer');
    expect(doc(inv).status).toBe('void');
    expect(stock(c.widget)).toBe(50);
    expect(bal('accounts_receivable')).toBe(0);
  });

  it('respects transaction lock dates', () => {
    setKv('lock_dates', { sales: '2026-05-31' });
    expect(() => sell(c, 1, 200, '2026-05-15')).toThrow(/locked/);
    expect(() => sell(c, 1, 200, '2026-06-01')).not.toThrow();
  });
});

describe('Order to cash', () => {
  it('runs quote → sales order → package → shipment → invoice with status tracking', () => {
    const qt = createDocument('quote', { date: '2026-05-01', contact_id: c.cust, lines: [{ item_id: c.widget, qty: 10, rate: 200 }, { item_id: c.service, qty: 1, rate: 1000 }] }, c.admin, { submit: true });
    const so = createFrom(qt, 'sales_order', c.admin, { date: '2026-05-02' });
    expect(doc(qt).status).toBe('accepted');
    expect(doc(so).status).toBe('confirmed');

    const draft = convertDraft(so, 'package');
    expect(draft.lines).toHaveLength(1); // services are not packed
    const pkg = createFrom(so, 'package', c.admin, { date: '2026-05-03', lines: [{ ...draft.lines![0], qty: 6 }] });
    expect(stock(c.widget)).toBe(50); // packed, not shipped
    runAction(pkg, 'ship', { date: '2026-05-04', carrier: 'BlueDart', tracking_no: 'BD1' }, c.admin);
    expect(stock(c.widget)).toBe(44);
    expect(doc(so).fulfil_status).toBe('partially_shipped');
    expect(() => createFrom(so, 'package', c.admin, { lines: [{ ...draft.lines![0], qty: 5 }] })).toThrow(/exceeds the remaining 4/);

    const inv = createFrom(so, 'invoice', c.admin, { date: '2026-05-05' });
    expect(doc(so).billing_status).toBe('invoiced');
    // Invoice from a sales order affects accounting stock only; physical stock moved with the package.
    expect(stock(c.widget)).toBe(44);
    expect(db().value("SELECT SUM(qty) FROM stock_moves WHERE item_id = ? AND accounting = 1", c.widget)).toBe(40);
    expect(bal('cogs')).toBe(1000);

    const pkg2 = createFrom(so, 'package', c.admin, { date: '2026-05-06' });
    runAction(pkg2, 'ship', { date: '2026-05-06' }, c.admin);
    runAction(pkg2, 'deliver', { date: '2026-05-07' }, c.admin);
    expect(doc(so)).toMatchObject({ fulfil_status: 'shipped', status: 'closed' });
    expect(() => deleteDocument(so, c.admin)).toThrow(/linked transaction/);
    void inv;
  });

  it('handles delivery challans that are later invoiced', () => {
    const dc = createDocument('delivery_challan', { date: '2026-05-01', contact_id: c.cust, data: { challan_type: 'Supply on approval' }, lines: [{ item_id: c.widget, qty: 5, rate: 200 }] }, c.admin, { submit: true });
    expect(stock(c.widget)).toBe(45);
    expect(bal('accounts_receivable')).toBe(0);
    const inv = createFrom(dc, 'invoice', c.admin, { date: '2026-05-10' });
    expect(doc(dc).status).toBe('invoiced');
    expect(stock(c.widget)).toBe(45);
    expect(bal('accounts_receivable')).toBe(1180);
    void inv;
  });

  it('processes sales returns into credit notes that restore stock and reverse COGS', () => {
    const so = createDocument('sales_order', { date: '2026-05-01', contact_id: c.cust, lines: [{ item_id: c.widget, qty: 10, rate: 200 }] }, c.admin, { submit: true });
    const pkg = createFrom(so, 'package', c.admin, { date: '2026-05-02' });
    runAction(pkg, 'ship', { date: '2026-05-02' }, c.admin);
    const inv = createFrom(so, 'invoice', c.admin, { date: '2026-05-02' });
    const rma = createFrom(inv, 'sales_return', c.admin, { date: '2026-05-05', lines: convertDraft(inv, 'sales_return').lines!.map((l) => ({ ...l, qty: 3 })) });
    runAction(rma, 'receive_return', { date: '2026-05-06' }, c.admin);
    expect(stock(c.widget)).toBe(43);
    const cn = createFrom(rma, 'credit_note', c.admin, { date: '2026-05-06' });
    expect(doc(cn)).toMatchObject({ taxable_total: 600, total: 708, status: 'open' });
    expect(doc(rma).status).toBe('credited');
    expect(bal('cogs')).toBe(700); // 1000 sold - 300 returned
    expect(bal('accounts_receivable')).toBe(2360 - 708);
    applyCredits({ credit_doc_id: cn }, [{ document_id: inv, amount: 708 }], c.admin);
    expect(doc(inv)).toMatchObject({ balance: 1652, status: 'partially_paid' });
    expect(doc(cn).status).toBe('closed');
    expect(inventoryReconciles()).toBe(true);
    expect(trialBalanced()).toBe(true);
  });
});

describe('Sales return ordering', () => {
  it('keeps an unreceived return out of physical stock even after a credit note', () => {
    const inv = sell(c, 5, 200, '2026-05-01');
    const rma = createFrom(inv, 'sales_return', c.admin, { date: '2026-05-02' });
    createFrom(rma, 'credit_note', c.admin, { date: '2026-05-03' });
    expect(doc(rma).status).toBe('approved');
    expect(stock(c.widget)).toBe(45);
    runAction(rma, 'receive_return', { date: '2026-05-04' }, c.admin);
    expect(doc(rma).status).toBe('credited');
    expect(stock(c.widget)).toBe(50);
    expect(inventoryReconciles()).toBe(true);
  });
});

describe('Payments received', () => {
  it('tracks partial and full payments and bank charges', () => {
    const inv = sell(c, 5, 200, '2026-05-01');
    const p1 = createPayment({ kind: 'received', date: '2026-05-10', contact_id: c.cust, amount: 500, bank_charges: 10, account_id: c.bank, allocations: [{ document_id: inv, amount: 500 }] }, c.admin);
    expect(doc(inv)).toMatchObject({ status: 'partially_paid', balance: 680 });
    expect(bal('bank_charges')).toBe(10);
    createPayment({ kind: 'received', date: '2026-05-11', contact_id: c.cust, amount: 680, account_id: c.bank, allocations: [{ document_id: inv, amount: 680 }] }, c.admin);
    expect(doc(inv)).toMatchObject({ status: 'paid', balance: 0 });
    expect(bal('accounts_receivable')).toBe(0);
    deletePayment(p1, c.admin);
    expect(doc(inv)).toMatchObject({ status: 'partially_paid', balance: 500 });
  });

  it('rejects over-allocation and keeps excess as customer credit', () => {
    const inv = sell(c, 5, 200, '2026-05-01');
    expect(() => createPayment({ kind: 'received', contact_id: c.cust, amount: 2000, account_id: c.bank, allocations: [{ document_id: inv, amount: 1500 }] }, c.admin)).toThrow(/exceeds the balance/);
    const p = createPayment({ kind: 'received', date: '2026-05-02', contact_id: c.cust, amount: 2000, account_id: c.bank, allocations: [{ document_id: inv, amount: 1180 }] }, c.admin);
    expect(paymentUnused(p)).toBe(820);
    expect(bal('accounts_receivable')).toBe(-820);
    const inv2 = sell(c, 2, 200, '2026-05-03');
    applyCredits({ payment_id: p }, [{ document_id: inv2, amount: 472 }], c.admin);
    expect(doc(inv2).status).toBe('paid');
    expect(paymentUnused(p)).toBe(348);
    createRefund({ payment_id: p, amount: 348, account_id: c.bank, date: '2026-05-04' }, c.admin);
    expect(paymentUnused(p)).toBe(0);
    expect(bal('accounts_receivable')).toBe(0);
    expect(trialBalanced()).toBe(true);
  });

  it('records TDS deducted by customers', () => {
    const inv = createDocument('invoice', { date: '2026-05-01', contact_id: c.cust, lines: [{ item_id: c.service, qty: 1, rate: 10000, tax_id: c.tax18 }] }, c.admin, { submit: true });
    createPayment({ kind: 'received', date: '2026-05-05', contact_id: c.cust, amount: 11600, tds_amount: 200, account_id: c.bank, allocations: [{ document_id: inv, amount: 11800 }] }, c.admin);
    expect(doc(inv).status).toBe('paid');
    expect(bal('tds_receivable')).toBe(200);
  });

  it('realises exchange differences on foreign currency invoices', () => {
    const usd = createDocument('invoice', { date: '2026-05-01', contact_id: c.cust, currency_code: 'USD', exchange_rate: 80, lines: [{ item_id: c.service, qty: 1, rate: 100, tax_id: c.tax18 }] }, c.admin, { submit: true });
    expect(bal('accounts_receivable')).toBe(9440);
    createPayment({ kind: 'received', date: '2026-05-20', contact_id: c.cust, amount: 118, currency_code: 'USD', exchange_rate: 82, account_id: c.bank, allocations: [{ document_id: usd, amount: 118 }] }, c.admin);
    expect(bal('accounts_receivable')).toBe(0);
    expect(bal('exchange_gain_loss')).toBe(-236); // gain shown as negative expense
    expect(trialBalanced()).toBe(true);
  });
});

describe('Approvals and e-invoicing', () => {
  it('requires multi-level approval before posting', () => {
    const accountant = db().value<number>("SELECT id FROM roles WHERE name = 'Accountant'");
    setKv('approvals', { invoice: { mode: 'multi', levels: [accountant] } });
    const inv = sell(c, 1, 200, '2026-05-01');
    expect(doc(inv).status).toBe('pending_approval');
    expect(bal('accounts_receivable')).toBe(0);
    runAction(inv, 'approve', {}, c.admin);
    expect(doc(inv).status).toBe('open');
    expect(bal('accounts_receivable')).toBe(236);
  });

  it('records and cancels an IRN, blocking edits while active', () => {
    setKv('org', { ...getKv('org', DEFAULT_ORG), einvoice_enabled: true });
    const inv = sell(c, 1, 200, '2026-05-01');
    expect(() => runAction(inv, 'einvoice_record', { irn: 'short', ack_no: '112610000000001', ack_date: '2026-05-01T10:00:00Z' }, c.admin)).toThrow(/64-character/);
    const irn = createHash('sha256').update('test').digest('hex');
    runAction(inv, 'einvoice_record', { irn, ack_no: '112610000000001', ack_date: new Date().toISOString(), signed_qr: 'signed.jwt.value' }, c.admin);
    const e = getDocument(inv).data.einvoice;
    expect(e).toMatchObject({ status: 'generated', irn, ack_no: '112610000000001', signed_qr: 'signed.jwt.value' });
    expect(() => updateDocument(inv, { contact_id: c.cust, lines: [{ item_id: c.widget, qty: 2, rate: 200 }] }, c.admin)).toThrow(/Cancel the e-invoice/);
    // The same IRN cannot be recorded on a second document.
    const inv2 = sell(c, 1, 200, '2026-05-01');
    expect(() => runAction(inv2, 'einvoice_record', { irn, ack_no: '112610000000002', ack_date: new Date().toISOString() }, c.admin)).toThrow(/already recorded/);
    runAction(inv, 'einvoice_cancel', { reason_code: 2 }, c.admin);
    expect(getDocument(inv).data.einvoice).toMatchObject({ status: 'cancelled', cancel_reason: 'Data entry mistake' });
  });

  it('builds the IRP payload with intra-state tax split and credit-note references', () => {
    const inv = sell(c, 2, 200, '2026-05-01');
    const { payload } = einvoicePayload(inv);
    expect(payload).toMatchObject({ Version: '1.1', TranDtls: { SupTyp: 'B2B' }, DocDtls: { Typ: 'INV', Dt: '01/05/2026' } });
    expect(payload.ItemList[0]).toMatchObject({ HsnCd: '8413', Qty: 2, Unit: 'PCS', UnitPrice: 200, TotAmt: 400, AssAmt: 400, GstRt: 18, CgstAmt: 36, SgstAmt: 36, IgstAmt: 0, TotItemVal: 472 });
    expect(payload.ValDtls).toMatchObject({ AssVal: 400, CgstVal: 36, SgstVal: 36, TotInvVal: 472 });
    const line = db().get<any>('SELECT * FROM document_lines WHERE document_id = ?', inv);
    const cn = createDocument('credit_note', { date: '2026-05-02', contact_id: c.cust, ref_doc_id: inv, lines: [{ item_id: c.widget, qty: 1, rate: 200, tax_id: c.tax18, ref_line_id: line.id }] }, c.admin, { submit: true });
    const cnPayload = einvoicePayload(cn).payload;
    expect(cnPayload.DocDtls.Typ).toBe('CRN');
    expect(cnPayload.RefDtls.PrecDocDtls[0]).toMatchObject({ InvNo: doc(inv).number, InvDt: '01/05/2026' });
  });

  it('refuses e-invoices for unregistered customers and lists missing data', () => {
    const inv = createDocument('invoice', { date: '2026-05-01', contact_id: c.consumer, lines: [{ item_id: c.service, qty: 1, rate: 1000 }] }, c.admin, { submit: true });
    expect(() => einvoicePayload(inv)).toThrow(/unregistered/);
    setKv('org', { ...getKv('org', DEFAULT_ORG), pincode: '' });
    expect(() => einvoicePayload(sell(c, 1, 200, '2026-05-01'))).toThrow(/PIN code/);
  });

  it('prepares the e-way bill JSON and records the e-way bill', () => {
    const inv = sell(c, 1, 200, '2026-05-01');
    expect(() => ewaybillPayload(inv, { distance: 100, transport_mode: 'road', vehicle_no: 'XX' })).toThrow(/Vehicle number/);
    const { entry } = ewaybillPayload(inv, { distance: 120, transport_mode: 'road', vehicle_no: 'ka 01 ab 1234' });
    expect(entry).toMatchObject({ supplyType: 'O', subSupplyType: 1, docType: 'INV', docDate: '01/05/2026', vehicleNo: 'KA01AB1234', vehicleType: 'R', transMode: 1, fromStateCode: 29, toStateCode: 29, mainHsnCode: 8413 });
    expect(entry.itemList[0]).toMatchObject({ hsnCode: 8413, quantity: 1, qtyUnit: 'PCS', taxableAmount: 200, cgstRate: 9, sgstRate: 9, igstRate: 0 });
    expect(() => runAction(inv, 'eway_record', { ewb_no: '123', distance: 450, vehicle_no: 'KA01AB1234' }, c.admin)).toThrow(/12-digit/);
    runAction(inv, 'eway_record', { ewb_no: '381000123456', ewb_date: '2026-05-01T09:00:00Z', distance: 450, transport_mode: 'road', vehicle_no: 'KA01AB1234' }, c.admin);
    expect(getDocument(inv).data.ewaybill).toMatchObject({ status: 'generated', ewb_no: '381000123456', validity_days: 3, valid_until: '2026-05-04T23:59:59' });
  });

  it('keeps org preferences when settings are partially stored', () => {
    expect(getKv('org', DEFAULT_ORG).fiscal_year_start_month).toBe(4);
  });
});

const r = (n: number) => Math.round(n * 100) / 100;
