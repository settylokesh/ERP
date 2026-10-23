import { loadUser, type AuthUser } from '../src/auth.js';
import { db, type Row } from '../src/db.js';
import { createDocument } from '../src/documents/engine.js';
import { acct, accountBalance } from '../src/ledger.js';
import { saveContact, saveItem } from '../src/masters.js';
import { initDatabase } from '../src/seed.js';
import { setKv, getKv, DEFAULT_ORG } from '../src/settings.js';
import { makeGstin } from '../src/util.js';

export interface Ctx {
  admin: AuthUser;
  wh: number;
  wh2: number;
  tax18: number;
  tax5: number;
  bank: number;
  cust: number;        // Karnataka, registered (intra-state)
  custMh: number;      // Maharashtra, registered (inter-state)
  consumer: number;    // unregistered consumer
  vendor: number;      // Karnataka registered vendor
  vendorUp: number;    // Uttar Pradesh registered vendor
  widget: number;      // stock item, no tracking
  service: number;
}

export function fresh(): Ctx {
  initDatabase(':memory:');
  const d = db();
  setKv('org', { ...getKv('org', DEFAULT_ORG), name: 'Test Co', gstin: makeGstin('29', 'AABCT1234Q'), state_code: '29', inventory_start_date: '2026-04-01' });
  const admin = loadUser(1)!;
  const wh = d.value<number>('SELECT id FROM warehouses LIMIT 1');
  const wh2 = d.insert('warehouses', { name: 'Second', is_primary: 0 });
  const tax18 = d.value<number>('SELECT id FROM taxes WHERE rate = 18');
  const tax5 = d.value<number>('SELECT id FROM taxes WHERE rate = 5');
  const bank = d.insert('accounts', { code: '1999', name: 'Test Bank', type: 'bank' });
  const cust = saveContact({ kind: 'customer', name: 'KA Customer', gst_treatment: 'business_gst', gstin: makeGstin('29', 'AAACK1111A'), email: 'ka@example.com', payment_terms: 30 });
  const custMh = saveContact({ kind: 'customer', name: 'MH Customer', gst_treatment: 'business_gst', gstin: makeGstin('27', 'AAACM2222B') });
  const consumer = saveContact({ kind: 'customer', name: 'Walk In', gst_treatment: 'consumer', place_of_supply: '29' });
  const vendor = saveContact({ kind: 'vendor', name: 'KA Vendor', gst_treatment: 'business_gst', gstin: makeGstin('29', 'AAACV3333C') });
  const vendorUp = saveContact({ kind: 'vendor', name: 'UP Vendor', gst_treatment: 'business_gst', gstin: makeGstin('09', 'AAACU4444D') });
  const widget = saveItem({ name: 'Widget', sku: 'W1', unit: 'pcs', hsn_code: '8413', tax_id: tax18, sales_rate: 200, purchase_rate: 100 });
  const service = saveItem({ name: 'Service', type: 'service', hsn_code: '998719', tax_id: tax18, sales_rate: 1000 });
  return { admin, wh, wh2, tax18, tax5, bank, cust, custMh, consumer, vendor, vendorUp, widget, service };
}

export function buy(c: Ctx, qty: number, rate: number, date: string, item = c.widget, extra: Row = {}) {
  return createDocument('bill', { date, contact_id: c.vendor, warehouse_id: c.wh, lines: [{ item_id: item, qty, rate, tax_id: c.tax18 }], ...extra }, c.admin, { submit: true });
}
export function sell(c: Ctx, qty: number, rate: number, date: string, item = c.widget, extra: Row = {}) {
  return createDocument('invoice', { date, contact_id: c.cust, warehouse_id: c.wh, lines: [{ item_id: item, qty, rate, tax_id: c.tax18 }], ...extra }, c.admin, { submit: true });
}

export const bal = (key: string) => accountBalance(acct(key));
export const doc = (id: number) => db().get<Row>('SELECT * FROM documents WHERE id = ?', id)!;
export const stock = (item: number, wh?: number) => db().value<number>(`SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = ? AND physical = 1 ${wh ? 'AND warehouse_id = ?' : ''}`, ...(wh ? [item, wh] : [item]));
export const cogsOf = (docId: number) => -db().value<number>("SELECT COALESCE(SUM(value),0) FROM stock_moves WHERE source_id = ? AND source_type = 'invoice'", docId);
export function trialBalanced() {
  const r = db().get<Row>('SELECT ROUND(SUM(debit),2) AS dr, ROUND(SUM(credit),2) AS cr FROM journal_lines');
  return Math.abs(r.dr - r.cr) < 0.005;
}
/** Inventory Asset ledger must always equal the sum of accounting stock values. */
export function inventoryReconciles() {
  const ledger = db().value<number>("SELECT COALESCE(SUM(jl.debit - jl.credit),0) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.type = 'stock'");
  const stockValue = db().value<number>('SELECT COALESCE(SUM(value),0) FROM stock_moves WHERE accounting = 1');
  return Math.abs(ledger - stockValue) < 0.01;
}
