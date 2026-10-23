import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { createDocument, updateDocument, deleteDocument } from '../src/documents/engine.js';
import { runAction } from '../src/documents/actions.js';
import { saveItem } from '../src/masters.js';
import { setKv, getKv, DEFAULT_ORG } from '../src/settings.js';
import { bal, buy, cogsOf, doc, fresh, inventoryReconciles, sell, stock, trialBalanced, type Ctx } from './helpers.js';

let c: Ctx;
beforeEach(() => { c = fresh(); });

describe('FIFO valuation', () => {
  it('costs sales from the oldest layers first', () => {
    buy(c, 10, 100, '2026-05-01');
    buy(c, 10, 120, '2026-05-02');
    const inv = sell(c, 15, 200, '2026-05-03');
    expect(cogsOf(inv)).toBe(1600); // 10 x 100 + 5 x 120
    expect(bal('cogs')).toBe(1600);
    expect(bal('inventory_asset')).toBe(600); // 5 x 120 left
    expect(inventoryReconciles()).toBe(true);
    expect(trialBalanced()).toBe(true);
  });

  it('re-costs later sales when a back-dated purchase is entered', () => {
    buy(c, 10, 100, '2026-05-10');
    const inv = sell(c, 10, 200, '2026-05-20');
    expect(cogsOf(inv)).toBe(1000);
    buy(c, 10, 50, '2026-05-01'); // cheaper stock existed earlier
    expect(cogsOf(inv)).toBe(500);
    expect(bal('cogs')).toBe(500);
    expect(inventoryReconciles()).toBe(true);
  });

  it('supports weighted average costing', () => {
    setKv('org', { ...getKv('org', DEFAULT_ORG), valuation_method: 'wac' });
    buy(c, 10, 100, '2026-05-01');
    buy(c, 10, 200, '2026-05-02');
    const inv = sell(c, 10, 300, '2026-05-03');
    expect(cogsOf(inv)).toBe(1500);
    expect(inventoryReconciles()).toBe(true);
  });

  it('values opening stock and posts it against opening balance adjustments', () => {
    saveItem({ name: 'Opening item', sku: 'OP1', tax_id: c.tax18, purchase_rate: 10, opening_stock: [{ warehouse_id: c.wh, qty: 5, rate: 40 }] });
    expect(bal('inventory_asset')).toBe(200);
    expect(bal('opening_balance_adjustments')).toBe(200);
  });
});

describe('Stock controls', () => {
  it('blocks invoices that would make stock negative', () => {
    buy(c, 2, 100, '2026-05-01');
    expect(() => sell(c, 3, 200, '2026-05-02')).toThrow(/Insufficient stock/);
    expect(stock(c.widget)).toBe(2);
  });

  it('allows negative stock when the preference is off and keeps the ledger reconciled', () => {
    setKv('org', { ...getKv('org', DEFAULT_ORG), prevent_negative_stock: false });
    const inv = sell(c, 3, 200, '2026-05-01');
    expect(cogsOf(inv)).toBe(300); // falls back to the item purchase rate
    buy(c, 5, 110, '2026-05-02');
    expect(inventoryReconciles()).toBe(true);
  });

  it('tracks serial numbers and rejects duplicates or unavailable serials', () => {
    const phone = saveItem({ name: 'Controller', sku: 'CTL', tracking: 'serial', tax_id: c.tax18, purchase_rate: 500 });
    buy(c, 2, 500, '2026-05-01', phone, { lines: [{ item_id: phone, qty: 2, rate: 500, tax_id: c.tax18, tracking: [{ serial_no: 'S1' }, { serial_no: 'S2' }] }] });
    expect(() => buy(c, 1, 500, '2026-05-02', phone, { lines: [{ item_id: phone, qty: 1, rate: 500, tax_id: c.tax18, tracking: [{ serial_no: 'S1' }] }] })).toThrow(/already in stock/);
    expect(() => sell(c, 1, 900, '2026-05-03', phone, { lines: [{ item_id: phone, qty: 1, rate: 900, tax_id: c.tax18, tracking: [{ serial_no: 'S9' }] }] })).toThrow(/not available/);
    expect(() => sell(c, 1, 900, '2026-05-03', phone, { lines: [{ item_id: phone, qty: 1, rate: 900, tax_id: c.tax18 }] })).toThrow(/Serial numbers are required/);
    sell(c, 1, 900, '2026-05-03', phone, { lines: [{ item_id: phone, qty: 1, rate: 900, tax_id: c.tax18, tracking: [{ serial_no: 'S2' }] }] });
    expect(stock(phone)).toBe(1);
  });

  it('enforces batch quantities', () => {
    const med = saveItem({ name: 'Resin', sku: 'RES', tracking: 'batch', tax_id: c.tax18, purchase_rate: 50 });
    buy(c, 10, 50, '2026-05-01', med, { lines: [{ item_id: med, qty: 10, rate: 50, tax_id: c.tax18, tracking: [{ batch_no: 'B1', qty: 6 }, { batch_no: 'B2', qty: 4 }] }] });
    expect(() => sell(c, 5, 80, '2026-05-02', med, { lines: [{ item_id: med, qty: 5, rate: 80, tax_id: c.tax18, tracking: [{ batch_no: 'B2', qty: 5 }] }] })).toThrow(/Batch B2/);
    expect(() => sell(c, 5, 80, '2026-05-02', med, { lines: [{ item_id: med, qty: 5, rate: 80, tax_id: c.tax18, tracking: [{ batch_no: 'B1', qty: 4 }] }] })).toThrow(/add up/);
    sell(c, 5, 80, '2026-05-02', med, { lines: [{ item_id: med, qty: 5, rate: 80, tax_id: c.tax18, tracking: [{ batch_no: 'B1', qty: 5 }] }] });
  });
});

describe('Inventory documents', () => {
  it('moves stock between warehouses with transfer orders without touching value', () => {
    buy(c, 10, 100, '2026-05-01');
    const to = createDocument('transfer_order', { date: '2026-05-02', warehouse_id: c.wh, to_warehouse_id: c.wh2, lines: [{ item_id: c.widget, qty: 4 }] }, c.admin, { submit: true });
    expect(doc(to).status).toBe('in_transit');
    expect(stock(c.widget, c.wh)).toBe(6);
    expect(stock(c.widget, c.wh2)).toBe(0);
    runAction(to, 'mark_transferred', { date: '2026-05-03' }, c.admin);
    expect(stock(c.widget, c.wh2)).toBe(4);
    expect(bal('inventory_asset')).toBe(1000);
  });

  it('posts quantity and value adjustments', () => {
    buy(c, 10, 100, '2026-05-01');
    createDocument('inventory_adjustment', { date: '2026-05-02', warehouse_id: c.wh, data: { mode: 'quantity', reason: 'Damaged' }, lines: [{ item_id: c.widget, qty: -2 }] }, c.admin, { submit: true });
    expect(bal('inventory_asset')).toBe(800);
    expect(bal('inventory_adjustment')).toBe(200);
    createDocument('inventory_adjustment', { date: '2026-05-03', warehouse_id: c.wh, data: { mode: 'value', reason: 'Revaluation' }, lines: [{ item_id: c.widget, qty2: 640 }] }, c.admin, { submit: true });
    expect(bal('inventory_asset')).toBe(640);
    const inv = sell(c, 8, 200, '2026-05-04');
    expect(cogsOf(inv)).toBe(640);
    expect(inventoryReconciles()).toBe(true);
  });

  it('turns stock count variances into an adjustment', () => {
    buy(c, 10, 100, '2026-05-01');
    const sc = createDocument('stock_count', { date: '2026-05-05', warehouse_id: c.wh, lines: [{ item_id: c.widget, qty: 0 }] }, c.admin);
    runAction(sc, 'start_count', {}, c.admin);
    expect(db().value('SELECT qty FROM document_lines WHERE document_id = ?', sc)).toBe(10);
    const line = db().value<number>('SELECT id FROM document_lines WHERE document_id = ?', sc);
    const r = runAction(sc, 'complete_count', { counts: [{ line_id: line, counted: 9 }] }, c.admin);
    expect(doc(sc).status).toBe('completed');
    expect((r.result as any).adjustment_id).toBeTruthy();
    expect(stock(c.widget)).toBe(9);
  });

  it('re-posts when a bill is edited and cleans up when deleted', () => {
    const b = buy(c, 10, 100, '2026-05-01');
    updateDocument(b, { date: '2026-05-01', contact_id: c.vendor, warehouse_id: c.wh, lines: [{ id: db().value('SELECT id FROM document_lines WHERE document_id = ?', b), item_id: c.widget, qty: 10, rate: 150, tax_id: c.tax18 }] }, c.admin);
    expect(bal('inventory_asset')).toBe(1500);
    deleteDocument(b, c.admin);
    expect(bal('inventory_asset')).toBe(0);
    expect(stock(c.widget)).toBe(0);
    expect(trialBalanced()).toBe(true);
  });
});
