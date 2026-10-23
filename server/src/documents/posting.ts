import { db, json, type Row } from '../db.js';
import { acct, replaceJournal, type JLine } from '../ledger.js';
import { currentUnitCost, isStockItem, revalueItems, setMoves, sourceStockValue, splitTracking, unitsRemainingFromLine, validateStock, type MoveSpec } from '../inventory.js';
import { openingDate } from '../settings.js';
import { r2 } from '../util.js';
import { DOC_TYPES } from './types.js';

export interface FullDoc extends Row {
  lines: Row[];
}

export function loadFull(id: number): FullDoc | null {
  const d = db();
  const doc = d.get<Row>('SELECT * FROM documents WHERE id = ?', id);
  if (!doc) return null;
  const lines = d.all<Row>(
    `SELECT l.*, i.name AS item_name, i.sku, i.type AS item_type, i.track_inventory, i.tracking AS tracking_mode,
            i.inventory_account_id, i.sales_account_id, i.purchase_account_id
     FROM document_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.document_id = ? ORDER BY l.line_no, l.id`, id);
  return { ...doc, lines };
}

export const isPosted = (doc: Row) => (DOC_TYPES[doc.type]?.posted ?? []).includes(doc.status);
/** Follows a credit note line back to the invoice line whose cost of sale it reverses. */
function originalSaleLine(lineId: number | null): number | null {
  let id = lineId;
  for (let i = 0; id && i < 3; i++) {
    const l = db().get<Row>('SELECT l.id, l.ref_line_id, d.type FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE l.id = ?', id);
    if (!l) return null;
    if (l.type === 'invoice') return l.id;
    id = l.ref_line_id;
  }
  return null;
}
const refType = (doc: Row) => (doc.ref_doc_id ? db().value<string>('SELECT type FROM documents WHERE id = ?', doc.ref_doc_id) : null);

/** Stock movements a document causes in its current status. */
export function buildMoves(doc: FullDoc): MoveSpec[] {
  if (!isPosted(doc)) return [];
  const ex = doc.exchange_rate || 1;
  const data = json<Row>(doc.data, {});
  const parent = refType(doc);
  const moves: MoveSpec[] = [];
  const stockLines = doc.lines.filter((l) => l.item_id && l.item_type === 'goods' && l.track_inventory);
  const add = (l: Row, spec: Omit<MoveSpec, 'item_id' | 'source_line_id'>, trackingRequired: boolean) => {
    const base: MoveSpec = { item_id: l.item_id, source_line_id: l.id, ...spec };
    const tracking = json<any[]>(l.tracking, []);
    moves.push(...splitTracking(base, tracking, trackingRequired ? l.tracking_mode : (tracking.length ? l.tracking_mode : 'none')));
  };
  const wh = (l: Row) => l.warehouse_id || doc.warehouse_id;
  switch (doc.type) {
    case 'invoice': {
      const physical = !(parent === 'sales_order' || parent === 'delivery_challan');
      for (const l of stockLines) add(l, { warehouse_id: wh(l), date: doc.date, qty: -l.qty, kind: 'sale', physical, accounting: true }, physical);
      break;
    }
    case 'credit_note': {
      const physical = parent !== 'sales_return';
      for (const l of stockLines) {
        if (json<Row>(l.data, {}).return_to_stock === false) continue;
        add(l, { warehouse_id: wh(l), date: doc.date, qty: l.qty, kind: 'return_in', physical, accounting: true, ref_source_line_id: originalSaleLine(l.ref_line_id) }, physical);
      }
      break;
    }
    case 'bill': {
      const physical = !(parent === 'purchase_order' || parent === 'purchase_receive');
      for (const l of stockLines) {
        const inelig = l.itc_eligible ? 0 : l.cgst + l.sgst + l.igst;
        const value = r2((l.taxable + l.landed_cost + inelig) * ex);
        add(l, { warehouse_id: wh(l), date: doc.date, qty: l.qty, kind: 'purchase', physical, accounting: true, value }, physical);
      }
      break;
    }
    case 'vendor_credit':
      for (const l of stockLines) {
        if (json<Row>(l.data, {}).return_to_stock === false) {
          // Price correction: no goods move. The reduction lowers the cost of the billed units that are still in stock;
          // the share relating to units already consumed goes to cost of goods sold (see buildJournal). Without a link
          // to the bill line the units cannot be identified, so the whole correction goes to cost of goods sold.
          const reduction = r2((l.taxable + (l.itc_eligible ? 0 : l.cgst + l.sgst + l.igst)) * ex);
          const billed = l.ref_line_id ? db().value<number>('SELECT qty FROM document_lines WHERE id = ?', l.ref_line_id) ?? 0 : 0;
          const remaining = billed > 0 ? unitsRemainingFromLine(l.item_id, l.ref_line_id, doc.date, [doc.type, doc.id]) : 0;
          const share = billed > 0 ? Math.min(1, remaining / billed) : 0;
          const delta = r2(reduction * share);
          if (delta) moves.push({ item_id: l.item_id, source_line_id: l.id, warehouse_id: wh(l), date: doc.date, qty: 0, kind: 'value_adjust', value_delta: -delta, physical: false, accounting: true });
          continue;
        }
        add(l, { warehouse_id: wh(l), date: doc.date, qty: -l.qty, kind: 'return_out', physical: true, accounting: true }, true);
      }
      break;
    case 'package': {
      const shipDate = data.shipment?.date || doc.date;
      for (const l of stockLines) add(l, { warehouse_id: wh(l), date: shipDate, qty: -l.qty, kind: 'ship', physical: true, accounting: false }, true);
      break;
    }
    case 'delivery_challan':
      for (const l of stockLines) add(l, { warehouse_id: wh(l), date: doc.date, qty: -l.qty, kind: 'challan', physical: true, accounting: false }, true);
      break;
    case 'sales_return': {
      const date = data.received_date || doc.date;
      for (const l of stockLines) add(l, { warehouse_id: wh(l), date, qty: l.qty, kind: 'receive', physical: true, accounting: false }, true);
      break;
    }
    case 'purchase_receive':
      for (const l of stockLines) {
        const qty = l.qty2 ?? l.qty;
        if (qty > 0) add(l, { warehouse_id: wh(l), date: doc.date, qty, kind: 'receive', physical: true, accounting: false }, true);
      }
      break;
    case 'transfer_order':
      for (const l of stockLines) {
        add(l, { warehouse_id: doc.warehouse_id, date: doc.date, qty: -l.qty, kind: 'transfer', physical: true, accounting: true }, true);
        if (doc.status === 'transferred') {
          add(l, { warehouse_id: doc.to_warehouse_id, date: data.transferred_date || doc.date, qty: l.qty, kind: 'transfer', physical: true, accounting: true }, true);
        }
      }
      break;
    case 'inventory_adjustment':
      for (const l of stockLines) {
        if (data.mode === 'value') {
          moves.push({ item_id: l.item_id, source_line_id: l.id, warehouse_id: wh(l), date: doc.date, qty: 0, kind: 'value_adjust', value_delta: r2(json<Row>(l.data, {}).value_delta ?? 0), physical: false, accounting: true });
        } else if (l.qty > 0) {
          const unit = l.rate > 0 ? l.rate : currentUnitCost(l.item_id);
          add(l, { warehouse_id: wh(l), date: doc.date, qty: l.qty, kind: 'adjust', value: r2(l.qty * unit), physical: true, accounting: true }, true);
        } else if (l.qty < 0) {
          add(l, { warehouse_id: wh(l), date: doc.date, qty: l.qty, kind: 'adjust', physical: true, accounting: true }, true);
        }
      }
      break;
  }
  return moves;
}

const lineAccount = (l: Row, side: 'sales' | 'purchase') =>
  l.account_id || (side === 'sales' ? l.sales_account_id || acct(l.item_type === 'service' ? 'service_income' : 'sales') : l.purchase_account_id || acct('purchases'));

/** Double-entry journal for a document in its current status (null when it does not touch the ledger). */
export function buildJournal(doc: FullDoc): { date: string; memo: string; lines: JLine[] } | null {
  if (!isPosted(doc)) return null;
  const ex = doc.exchange_rate || 1;
  const b = (x: number) => r2((x || 0) * ex);
  const c = doc.contact_id ?? null;
  const data = json<Row>(doc.data, {});
  const lines: JLine[] = [];
  const memo = `${DOC_TYPES[doc.type].label} ${doc.number}`;
  const stockOut = (counterKey: string) => {
    for (const g of sourceStockValue(doc.type, doc.id)) {
      const v = r2(g.value);
      if (!v) continue;
      const inv = g.inventory_account_id || acct('inventory_asset');
      const counter = counterKey === 'cogs' ? (g.purchase_account_id && db().value<string>('SELECT type FROM accounts WHERE id = ?', g.purchase_account_id) === 'cost_of_goods_sold' ? g.purchase_account_id : acct('cogs')) : acct(counterKey);
      // v is negative for outflows, positive for inflows
      lines.push({ account_id: inv, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0, item_id: g.item_id, contact_id: c });
      lines.push({ account_id: counter, debit: v < 0 ? -v : 0, credit: v > 0 ? v : 0, item_id: g.item_id, contact_id: c });
    }
  };

  switch (doc.type) {
    case 'invoice':
    case 'credit_note': {
      const sign = doc.type === 'invoice' ? 1 : -1; // invoice credits income; credit note debits it
      const push = (account_id: number, amt: number, item_id?: number) => {
        if (!amt) return;
        lines.push(sign > 0 ? { account_id, credit: amt, contact_id: c, item_id } : { account_id, debit: amt, contact_id: c, item_id });
      };
      for (const l of doc.lines) push(lineAccount(l, 'sales'), b(l.taxable), l.item_id);
      push(acct('output_cgst'), b(doc.cgst_total));
      push(acct('output_sgst'), b(doc.sgst_total));
      push(acct('output_igst'), b(doc.igst_total));
      if (doc.adjustment) push(acct('rounding'), b(doc.adjustment));
      const ar = r2(lines.reduce((a, l) => a + (l.credit ?? 0) - (l.debit ?? 0), 0));
      lines.push({ account_id: acct('accounts_receivable'), debit: ar > 0 ? ar : 0, credit: ar < 0 ? -ar : 0, contact_id: c });
      stockOut('cogs');
      break;
    }
    case 'bill':
    case 'expense':
    case 'vendor_credit': {
      const sign = doc.type === 'vendor_credit' ? -1 : 1; // bills debit cost/asset accounts
      const push = (account_id: number, amt: number, item_id?: number, desc?: string) => {
        if (!amt) return;
        lines.push(sign > 0 ? { account_id, debit: amt, contact_id: c, item_id, description: desc } : { account_id, credit: amt, contact_id: c, item_id, description: desc });
      };
      const stockValues = new Map<number, number>();
      for (const g of sourceStockValue(doc.type, doc.id)) stockValues.set(g.source_line_id, (stockValues.get(g.source_line_id) ?? 0) + g.value);
      const hasStockLines = doc.lines.some((l) => stockValues.has(l.id));
      for (const l of doc.lines) {
        const tax = l.cgst + l.sgst + l.igst;
        const inelig = l.itc_eligible ? 0 : tax;
        const ld = json<Row>(l.data, {});
        if (ld.landed_cost && hasStockLines && doc.type === 'bill') continue; // capitalised into stock lines
        if (stockValues.has(l.id)) {
          const v = Math.abs(r2(stockValues.get(l.id)!));
          const inv = l.inventory_account_id || acct('inventory_asset');
          if (doc.type === 'vendor_credit') {
            // Returns credit inventory at its carrying cost; price corrections credit only the share still in stock.
            // Any difference to the credited amount is a cost-of-goods-sold variance.
            const amount = b(l.taxable + inelig);
            lines.push({ account_id: inv, credit: v, item_id: l.item_id, contact_id: c });
            const variance = r2(amount - v);
            if (variance) lines.push({ account_id: acct('cogs'), credit: variance, item_id: l.item_id, contact_id: c, description: ld.return_to_stock === false ? 'Purchase price correction on goods already consumed' : 'Purchase return price variance' });
          } else {
            push(inv, v, l.item_id);
          }
        } else if (doc.type === 'vendor_credit' && ld.return_to_stock === false && l.item_type === 'goods' && l.track_inventory) {
          // A price correction whose units have all been consumed (or that is not linked to a bill line) reduces cost of
          // goods sold, the account those units were expensed to.
          push(acct('cogs'), b(l.taxable + inelig), l.item_id, 'Purchase price correction on goods already consumed');
        } else {
          push(lineAccount(l, 'purchase'), b(l.taxable + inelig), l.item_id, l.description);
        }
      }
      const elig = doc.lines.filter((l) => l.itc_eligible);
      const cg = b(elig.reduce((a, l) => a + l.cgst, 0)), sg = b(elig.reduce((a, l) => a + l.sgst, 0)), ig = b(elig.reduce((a, l) => a + l.igst, 0));
      push(acct('input_cgst'), cg);
      push(acct('input_sgst'), sg);
      push(acct('input_igst'), ig);
      if (doc.reverse_charge) {
        const rcm = b(doc.cgst_total + doc.sgst_total + doc.igst_total);
        if (rcm) lines.push(sign > 0 ? { account_id: acct('rcm_payable'), credit: rcm } : { account_id: acct('rcm_payable'), debit: rcm });
      }
      if (doc.tds_amount) {
        const t = b(doc.tds_amount);
        lines.push(sign > 0 ? { account_id: acct('tds_payable'), credit: t, contact_id: c } : { account_id: acct('tds_payable'), debit: t, contact_id: c });
      }
      if (doc.adjustment) push(acct('rounding'), b(doc.adjustment));
      const balancing = r2(lines.reduce((a, l) => a + (l.debit ?? 0) - (l.credit ?? 0), 0));
      const counter = doc.type === 'expense' ? (data.paid_through_account_id || acct('petty_cash')) : acct('accounts_payable');
      lines.push({ account_id: counter, credit: balancing > 0 ? balancing : 0, debit: balancing < 0 ? -balancing : 0, contact_id: c });
      break;
    }
    case 'inventory_adjustment': {
      const counter = data.account_id || acct('inventory_adjustment');
      for (const g of sourceStockValue(doc.type, doc.id)) {
        const v = r2(g.value);
        if (!v) continue;
        const inv = g.inventory_account_id || acct('inventory_asset');
        lines.push({ account_id: inv, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0, item_id: g.item_id });
        lines.push({ account_id: counter, debit: v < 0 ? -v : 0, credit: v > 0 ? v : 0, item_id: g.item_id, description: data.reason ?? null });
      }
      break;
    }
    default:
      return null;
  }
  return { date: doc.date, memo, lines };
}

/** Rebuilds stock moves, revalues affected items and re-posts the journal of a document. */
export function syncPosting(id: number) {
  const doc = loadFull(id);
  if (!doc) return;
  const moves = buildMoves(doc);
  const items = setMoves(doc.type, doc.id, moves);
  if (moves.some((m) => m.physical !== false)) validateStock(doc.type, doc.id);
  revalueItems(items, `${doc.type}:${doc.id}`);
  const j = buildJournal(loadFull(id)!);
  replaceJournal(doc.type, doc.id, j ? { ...j, reference: doc.number } : null);
}

/** Journal-only rebuild used when stock values change due to a back-dated transaction elsewhere. */
export function repostJournal(type: string, id: number) {
  const doc = loadFull(id);
  if (!doc) return;
  const j = buildJournal(doc);
  replaceJournal(type, id, j ? { ...j, reference: doc.number } : null);
}

export function postItemOpening(itemId: number) {
  const d = db();
  const item = d.get<Row>('SELECT * FROM items WHERE id = ?', itemId);
  if (!item) return;
  const date = openingDate();
  const rows = isStockItem(item) ? json<Row[]>(item.opening_stock, []) : [];
  const moves: MoveSpec[] = [];
  for (const r of rows) {
    const qty = Number(r.qty) || 0;
    if (qty <= 0) continue;
    const base: MoveSpec = { item_id: itemId, warehouse_id: Number(r.warehouse_id), date, qty, kind: 'opening', value: r2(qty * (Number(r.rate) || 0)) };
    moves.push(...splitTracking(base, r.tracking ?? [], (r.tracking ?? []).length ? item.tracking : 'none'));
  }
  const items = setMoves('item_opening', itemId, moves);
  revalueItems(items, `item_opening:${itemId}`);
  postOpeningJournal(itemId);
}
export function postOpeningJournal(itemId: number) {
  const d = db();
  const item = d.get<Row>('SELECT * FROM items WHERE id = ?', itemId);
  const value = d.value<number>("SELECT COALESCE(SUM(value),0) FROM stock_moves WHERE source_type = 'item_opening' AND source_id = ?", itemId) ?? 0;
  const date = d.value<string>("SELECT MIN(date) FROM stock_moves WHERE source_type = 'item_opening' AND source_id = ?", itemId);
  replaceJournal('item_opening', itemId, value && date ? {
    date, memo: `Opening stock - ${item?.name}`, lines: [
      { account_id: item?.inventory_account_id || acct('inventory_asset'), debit: value, item_id: itemId },
      { account_id: acct('opening_balance_adjustments'), credit: value, item_id: itemId },
    ],
  } : null);
}
