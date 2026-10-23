import { db, fail, type Row } from './db.js';
import { org } from './settings.js';
import { r2 } from './util.js';

export interface MoveSpec {
  item_id: number;
  warehouse_id: number;
  date: string;
  qty: number;
  physical?: boolean;
  accounting?: boolean;
  kind: string;
  /** Fixed value (base currency) for inflows such as purchases and opening stock. */
  value?: number | null;
  /** For value adjustments (qty 0). */
  value_delta?: number;
  source_line_id?: number | null;
  ref_source_line_id?: number | null;
  batch_no?: string | null;
  serial_no?: string | null;
  expiry_date?: string | null;
  in_transit?: boolean;
}

/** Inflows whose value is supplied by the source document. */
const FIXED_INFLOW = new Set(['opening', 'purchase', 'adjust', 'count', 'receive']);
const VALUATION_NEUTRAL = new Set(['transfer']);

type Reposter = (sourceType: string, sourceId: number) => void;
let reposter: Reposter | null = null;
/** The document layer registers how to rebuild a source's journal once its stock values change. */
export function setReposter(fn: Reposter) {
  reposter = fn;
}

export function isStockItem(item: Row | undefined | null): boolean {
  return !!item && item.type === 'goods' && !!item.track_inventory;
}

/** Expands a document line's tracking info into per-batch / per-serial move specs. */
export function splitTracking(base: MoveSpec, tracking: { batch_no?: string; serial_no?: string; qty?: number; expiry_date?: string }[] | undefined, trackingMode: string): MoveSpec[] {
  const sign = Math.sign(base.qty) || 1;
  const total = Math.abs(base.qty);
  if (trackingMode === 'none' || !tracking?.length) {
    if (trackingMode === 'serial' && total > 0 && base.physical !== false && !tracking?.length) {
      fail(`Serial numbers are required for item #${base.item_id}`, 422);
    }
    if (trackingMode === 'batch' && total > 0 && base.physical !== false && !tracking?.length) {
      fail(`Batch details are required for item #${base.item_id}`, 422);
    }
    return [base];
  }
  if (trackingMode === 'serial') {
    const serials = tracking.map((t) => String(t.serial_no ?? '').trim()).filter(Boolean);
    if (new Set(serials).size !== serials.length) fail('Duplicate serial numbers on the same line', 422);
    if (Math.abs(serials.length - total) > 1e-9) fail(`Item #${base.item_id} needs exactly ${total} serial numbers (got ${serials.length})`, 422);
    const perValue = base.value != null ? base.value / serials.length : null;
    return serials.map((s) => ({ ...base, qty: sign, serial_no: s, value: perValue }));
  }
  const tq = tracking.reduce((a, t) => a + Number(t.qty || 0), 0);
  if (Math.abs(tq - total) > 1e-6) fail(`Batch quantities (${tq}) must add up to the line quantity (${total})`, 422);
  return tracking.map((t) => ({
    ...base,
    qty: sign * Number(t.qty || 0),
    batch_no: String(t.batch_no ?? '').trim() || fail('Batch number is required', 422),
    expiry_date: t.expiry_date ?? null,
    value: base.value != null ? (base.value * Number(t.qty || 0)) / total : null,
  }));
}

/** Replaces the stock moves of a source document. Returns the item ids whose valuation must be recomputed. */
export function setMoves(sourceType: string, sourceId: number, moves: MoveSpec[]): number[] {
  const d = db();
  const affected = new Set<number>(
    d.all<{ item_id: number }>('SELECT DISTINCT item_id FROM stock_moves WHERE source_type = ? AND source_id = ?', sourceType, sourceId).map((r) => r.item_id),
  );
  d.run('DELETE FROM stock_moves WHERE source_type = ? AND source_id = ?', sourceType, sourceId);
  for (const m of moves) {
    if (!m.qty && m.kind !== 'value_adjust') continue;
    affected.add(m.item_id);
    const fixed = m.value != null && m.qty ? m.value / m.qty : null;
    d.insert('stock_moves', {
      item_id: m.item_id, warehouse_id: m.warehouse_id, date: m.date, qty: m.qty,
      physical: m.physical === false ? 0 : 1, accounting: m.accounting === false ? 0 : 1, kind: m.kind,
      unit_cost: fixed, value: m.value != null ? r2(m.value) : 0, value_delta: m.value_delta ?? 0,
      source_type: sourceType, source_id: sourceId, source_line_id: m.source_line_id ?? null,
      ref_source_line_id: m.ref_source_line_id ?? null, batch_no: m.batch_no ?? null, serial_no: m.serial_no ?? null,
      expiry_date: m.expiry_date ?? null, in_transit: m.in_transit ? 1 : 0,
    });
  }
  return [...affected];
}

/** Rejects a source document that would push physical stock (or a batch/serial) below zero. */
export function validateStock(sourceType: string, sourceId: number) {
  const d = db();
  const touched = d.all<Row>(
    `SELECT DISTINCT m.item_id, m.warehouse_id, i.name, i.tracking FROM stock_moves m JOIN items i ON i.id = m.item_id
     WHERE m.source_type = ? AND m.source_id = ? AND m.physical = 1`, sourceType, sourceId);
  const prevent = org().prevent_negative_stock;
  for (const t of touched) {
    if (prevent) {
      const qty = d.value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = ? AND warehouse_id = ? AND physical = 1', t.item_id, t.warehouse_id);
      if (qty < -1e-6) {
        const wh = d.value<string>('SELECT name FROM warehouses WHERE id = ?', t.warehouse_id);
        fail(`Insufficient stock for "${t.name}" in ${wh}. Stock would become ${r2(qty)}.`, 422);
      }
    }
    if (t.tracking === 'batch') {
      const bad = d.get<Row>(
        `SELECT batch_no, SUM(qty) q FROM stock_moves WHERE item_id = ? AND warehouse_id = ? AND physical = 1 AND batch_no IN
         (SELECT batch_no FROM stock_moves WHERE source_type = ? AND source_id = ? AND item_id = ?) GROUP BY batch_no HAVING q < -0.000001`,
        t.item_id, t.warehouse_id, sourceType, sourceId, t.item_id);
      if (bad) fail(`Batch ${bad.batch_no} of "${t.name}" does not have enough stock`, 422);
    }
    if (t.tracking === 'serial') {
      const serials = d.all<{ serial_no: string }>(
        'SELECT DISTINCT serial_no FROM stock_moves WHERE source_type = ? AND source_id = ? AND item_id = ? AND physical = 1', sourceType, sourceId, t.item_id);
      for (const { serial_no } of serials) {
        const total = d.value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = ? AND serial_no = ? AND physical = 1', t.item_id, serial_no);
        const here = d.value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = ? AND serial_no = ? AND warehouse_id = ? AND physical = 1', t.item_id, serial_no, t.warehouse_id);
        if (total > 1 + 1e-9) fail(`Serial number ${serial_no} of "${t.name}" is already in stock`, 422);
        if (total < -1e-9 || here < -1e-9) fail(`Serial number ${serial_no} of "${t.name}" is not available in this warehouse`, 422);
      }
    }
  }
}

/**
 * Recomputes FIFO (or weighted average) values of all accounting moves of the given items by replaying them in date order.
 * Source documents whose stock values changed get their journals rebuilt, so the Inventory Asset ledger always equals
 * the sum of stock move values. Manufacturing outputs are revalued after their components.
 */
export function revalueItems(itemIds: Iterable<number>, exclude?: string): Set<string> {
  const d = db();
  const method = org().valuation_method;
  const changedSources = new Set<string>();
  const queue = [...new Set(itemIds)];
  const passes = new Map<number, number>();
  while (queue.length) {
    const itemId = queue.shift()!;
    const n = (passes.get(itemId) ?? 0) + 1;
    passes.set(itemId, n);
    if (n > 25) continue; // guards against BOM cycles
    const changed = replayItem(itemId, method);
    for (const key of changed) {
      changedSources.add(key);
      if (key.startsWith('mo:')) {
        const moId = Number(key.slice(3));
        const fg = d.value<number>('SELECT item_id FROM manufacturing_orders WHERE id = ?', moId);
        if (fg && fg !== itemId && !queue.includes(fg)) queue.push(fg);
      }
    }
  }
  if (reposter) {
    for (const key of changedSources) {
      if (key === exclude) continue;
      const [type, id] = key.split(':');
      reposter(type, Number(id));
    }
  }
  return changedSources;
}

function replayItem(itemId: number, method: 'fifo' | 'wac'): string[] {
  const d = db();
  const item = d.get<Row>('SELECT purchase_rate FROM items WHERE id = ?', itemId);
  const moves = d.all<Row>(
    `SELECT * FROM stock_moves WHERE item_id = ? AND accounting = 1 ORDER BY date,
       CASE WHEN kind = 'return_in' THEN 3 WHEN qty > 0 THEN 0 WHEN qty = 0 THEN 1 ELSE 2 END, id`, itemId);
  const layers: { qty: number; cost: number }[] = [];
  let deficit = 0; // quantity issued while stock was negative
  let lastCost = item?.purchase_rate ?? 0;
  const changed = new Set<string>();
  const avg = () => {
    const q = layers.reduce((a, l) => a + l.qty, 0);
    const v = layers.reduce((a, l) => a + l.qty * l.cost, 0);
    return q > 1e-9 ? v / q : lastCost;
  };
  const moInputs = new Map<number, number>();

  for (const m of moves) {
    let value = 0;
    if (VALUATION_NEUTRAL.has(m.kind)) {
      value = 0;
    } else if (m.qty > 0) {
      let unit: number;
      if (FIXED_INFLOW.has(m.kind) && m.unit_cost != null) unit = m.unit_cost;
      else if (m.kind === 'return_in') {
        const orig = m.ref_source_line_id
          ? d.get<Row>(`SELECT SUM(value) v, SUM(qty) q FROM stock_moves WHERE source_line_id = ? AND item_id = ? AND accounting = 1 AND qty < 0`, m.ref_source_line_id, itemId)
          : undefined;
        unit = orig && orig.q ? orig.v / orig.q : avg();
      } else if (m.kind === 'mo_produce') {
        let material = moInputs.get(m.source_id);
        if (material === undefined) {
          material = -(d.value<number>(`SELECT COALESCE(SUM(value),0) FROM stock_moves WHERE source_type = 'mo' AND source_id = ? AND kind = 'mo_consume'`, m.source_id) ?? 0);
          moInputs.set(m.source_id, material);
        }
        const mo = d.get<Row>('SELECT labour_cost, overhead_cost, produced_qty FROM manufacturing_orders WHERE id = ?', m.source_id);
        const totalOut = d.value<number>(`SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE source_type = 'mo' AND source_id = ? AND kind = 'mo_produce'`, m.source_id) || m.qty;
        unit = (material + (mo?.labour_cost ?? 0) + (mo?.overhead_cost ?? 0)) / totalOut;
      } else unit = m.unit_cost ?? avg();
      if (!Number.isFinite(unit)) unit = lastCost;
      value = r2(m.qty * unit);
      let qtyLeft = m.qty;
      if (deficit > 0) {
        const fill = Math.min(deficit, qtyLeft);
        deficit -= fill;
        qtyLeft -= fill;
      }
      if (qtyLeft > 1e-9) layers.push({ qty: qtyLeft, cost: unit });
      lastCost = unit;
    } else if (m.qty === 0) {
      // Value adjustment: spread across on-hand layers.
      value = r2(m.value_delta);
      const q = layers.reduce((a, l) => a + l.qty, 0);
      if (q > 1e-9) for (const l of layers) l.cost += m.value_delta / q;
    } else {
      let need = -m.qty;
      let cost = 0;
      if (method === 'wac') {
        const unit = avg();
        const q = layers.reduce((a, l) => a + l.qty, 0);
        const take = Math.min(need, q);
        cost += take * unit;
        if (q > 1e-9) {
          const remaining = q - take;
          layers.splice(0, layers.length);
          if (remaining > 1e-9) layers.push({ qty: remaining, cost: unit });
        }
        need -= take;
        if (need > 1e-9) {
          cost += need * unit;
          deficit += need;
        }
      } else {
        while (need > 1e-9 && layers.length) {
          const l = layers[0];
          const take = Math.min(need, l.qty);
          cost += take * l.cost;
          l.qty -= take;
          need -= take;
          if (l.qty <= 1e-9) layers.shift();
        }
        if (need > 1e-9) {
          cost += need * lastCost;
          deficit += need;
        }
      }
      value = -r2(cost);
    }
    if (Math.abs((m.value ?? 0) - value) > 0.0049) {
      d.run('UPDATE stock_moves SET value = ? WHERE id = ?', value, m.id);
      changed.add(`${m.source_type}:${m.source_id}`);
    }
  }
  return [...changed];
}

export function sourceStockValue(sourceType: string, sourceId: number, filter: 'in' | 'out' | 'all' = 'all'): Row[] {
  return db().all(
    `SELECT m.item_id, m.source_line_id, i.inventory_account_id, i.purchase_account_id, SUM(m.value) AS value, SUM(m.qty) AS qty
     FROM stock_moves m JOIN items i ON i.id = m.item_id
     WHERE m.source_type = ? AND m.source_id = ? AND m.accounting = 1 AND m.kind <> 'transfer'
       ${filter === 'in' ? 'AND m.qty >= 0' : filter === 'out' ? 'AND m.qty < 0' : ''}
     GROUP BY m.item_id, m.source_line_id`, sourceType, sourceId);
}

/**
 * Units received on a purchase line that are still in accounting stock on a date.
 * FIFO: issues use up the oldest receipts first, so the line's units remain only once everything received before it
 * has been consumed. Weighted average: stock is pooled, so the line keeps the same share as the pool that remains out
 * of everything available since the line was received. Transfers between warehouses do not consume stock.
 */
export function unitsRemainingFromLine(itemId: number, sourceLineId: number, asOf: string, exclude: [string, number]): number {
  const d = db();
  const scope = `item_id = ? AND accounting = 1 AND kind <> 'transfer' AND date <= ? AND NOT (source_type = ? AND source_id = ?)`;
  const args = [itemId, asOf, exclude[0], exclude[1]];
  const own = d.get<Row>(`SELECT COALESCE(SUM(qty), 0) AS qty, MIN(date) AS received FROM stock_moves WHERE ${scope} AND source_line_id = ? AND qty > 0`, ...args, sourceLineId);
  if (!own || !(own.qty > 0)) return 0;
  if (org().valuation_method === 'wac') {
    const t = d.get<Row>(
      `SELECT COALESCE(SUM(CASE WHEN date <= ? THEN qty ELSE 0 END), 0) AS pool_after,
              COALESCE(SUM(CASE WHEN date > ? AND qty > 0 THEN qty ELSE 0 END), 0) AS later_in, COALESCE(SUM(qty), 0) AS on_hand
       FROM stock_moves WHERE ${scope}`, own.received, own.received, ...args)!;
    const base = t.pool_after + t.later_in;
    return base > 1e-9 ? own.qty * Math.min(1, Math.max(0, t.on_hand / base)) : 0;
  }
  // FIFO: a receipt's units are left once all issues are covered by the receipts before it (same order as revaluation).
  const issued = d.value<number>(`SELECT COALESCE(SUM(-qty), 0) FROM stock_moves WHERE ${scope} AND qty < 0`, ...args) ?? 0;
  const receipts = d.all<Row>(
    `SELECT qty, cum FROM (
       SELECT qty, source_line_id, SUM(qty) OVER (ORDER BY date, CASE WHEN kind = 'return_in' THEN 1 ELSE 0 END, id ROWS UNBOUNDED PRECEDING) AS cum
       FROM stock_moves WHERE ${scope} AND qty > 0) WHERE source_line_id = ?`, ...args, sourceLineId);
  return receipts.reduce((a, m) => a + Math.min(m.qty, Math.max(0, m.cum - issued)), 0);
}

// ---------- Stock queries ----------

/** Quantity on confirmed sales orders that has not yet left the warehouse (shipped packages or delivery challans). */
export function committedQty(itemId: number, warehouseId?: number): number {
  return db().value<number>(
    `SELECT COALESCE(SUM(MAX(0, l.qty - COALESCE((SELECT SUM(pl.qty) FROM document_lines pl JOIN documents p ON p.id = pl.document_id
        WHERE pl.ref_line_id = l.id AND ((p.type = 'package' AND p.status IN ('shipped','delivered'))
          OR (p.type = 'delivery_challan' AND p.status IN ('open','delivered','invoiced')))), 0))), 0)
     FROM document_lines l JOIN documents d ON d.id = l.document_id
     WHERE d.type = 'sales_order' AND d.status = 'confirmed' AND l.item_id = ? AND (? IS NULL OR COALESCE(l.warehouse_id, d.warehouse_id) = ?)`,
    itemId, warehouseId ?? null, warehouseId ?? null) ?? 0;
}
/** Quantity on issued purchase orders not yet received (accepted quantity of receives). */
export function incomingQty(itemId: number): number {
  return db().value<number>(
    `SELECT COALESCE(SUM(MAX(0, l.qty - COALESCE((SELECT SUM(COALESCE(rl.qty2, rl.qty)) FROM document_lines rl JOIN documents r ON r.id = rl.document_id
        WHERE rl.ref_line_id = l.id AND r.type = 'purchase_receive'), 0))), 0)
     FROM document_lines l JOIN documents d ON d.id = l.document_id
     WHERE d.type = 'purchase_order' AND d.status = 'issued' AND l.item_id = ?`, itemId) ?? 0;
}

export function stockSummary(itemId: number) {
  const d = db();
  const physical = d.value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = ? AND physical = 1', itemId) ?? 0;
  const accounting = d.value<number>("SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = ? AND accounting = 1", itemId) ?? 0;
  const value = d.value<number>("SELECT COALESCE(SUM(value),0) FROM stock_moves WHERE item_id = ? AND accounting = 1", itemId) ?? 0;
  const committed = Math.max(0, committedQty(itemId));
  const incoming = Math.max(0, incomingQty(itemId));
  const warehouses = d.all<Row>(
    `SELECT w.id AS warehouse_id, w.name,
        COALESCE(SUM(CASE WHEN m.physical = 1 THEN m.qty END), 0) AS physical,
        COALESCE(SUM(CASE WHEN m.accounting = 1 THEN m.qty END), 0) AS accounting
     FROM warehouses w LEFT JOIN stock_moves m ON m.warehouse_id = w.id AND m.item_id = ?
     WHERE w.is_active = 1 GROUP BY w.id ORDER BY w.is_primary DESC, w.name`, itemId).map((w) => ({
    ...w, physical: r2(w.physical), accounting: r2(w.accounting), committed: r2(Math.max(0, committedQty(itemId, w.warehouse_id))),
  }));
  return {
    physical: r2(physical), accounting: r2(accounting), committed: r2(committed), available: r2(physical - committed),
    incoming: r2(incoming), value: r2(value), avg_cost: accounting > 1e-9 ? r2(value / accounting) : 0, warehouses,
  };
}

export function availableBatches(itemId: number, warehouseId: number) {
  return db().all(
    `SELECT batch_no, MAX(expiry_date) AS expiry_date, SUM(qty) AS qty FROM stock_moves
     WHERE item_id = ? AND warehouse_id = ? AND physical = 1 AND batch_no IS NOT NULL GROUP BY batch_no HAVING SUM(qty) > 0.000001
     ORDER BY expiry_date IS NULL, expiry_date, batch_no`, itemId, warehouseId);
}
export function availableSerials(itemId: number, warehouseId: number): string[] {
  return db().all<{ serial_no: string }>(
    `SELECT serial_no FROM stock_moves WHERE item_id = ? AND warehouse_id = ? AND physical = 1 AND serial_no IS NOT NULL
     GROUP BY serial_no HAVING SUM(qty) > 0.5 ORDER BY serial_no`, itemId, warehouseId).map((r) => r.serial_no);
}

/** Current average unit cost from accounting stock, used to price adjustments and returns without history. */
export function currentUnitCost(itemId: number): number {
  const d = db();
  const r = d.get<Row>('SELECT SUM(qty) q, SUM(value) v FROM stock_moves WHERE item_id = ? AND accounting = 1', itemId);
  if (r && r.q > 1e-9) return r.v / r.q;
  return d.value<number>('SELECT purchase_rate FROM items WHERE id = ?', itemId) ?? 0;
}
