import { audit, notify } from './activity.js';
import type { AuthUser } from './auth.js';
import { db, fail, json, type Row } from './db.js';
import { afterSave, primaryWarehouse } from './documents/engine.js';
import { availableBatches, committedQty, incomingQty, isStockItem, revalueItems, setMoves, splitTracking, validateStock, type MoveSpec } from './inventory.js';
import { acct, journalsFor, replaceJournal, type JLine } from './ledger.js';
import { assertUnlocked, nextNumber } from './settings.js';
import { isDate, r2, r4, today } from './util.js';

// ---------------- Work centres ----------------

export function saveWorkCenter(input: Row, id?: number) {
  const d = db();
  const name = String(input.name ?? '').trim() || fail('Work centre name is required', 422);
  const code = String(input.code ?? '').trim() || null;
  if (code && d.get('SELECT 1 FROM work_centers WHERE code = ? AND id <> ?', code, id ?? -1)) fail('Code already used', 409);
  const row = { name, code, cost_per_hour: Math.max(0, Number(input.cost_per_hour) || 0), capacity_hours: Math.max(0.5, Number(input.capacity_hours) || 8), description: input.description ?? null, is_active: input.is_active === false || input.is_active === 0 ? 0 : 1 };
  if (id) { d.update('work_centers', id, row); return id; }
  return d.insert('work_centers', row);
}

export function listWorkCenters() {
  const d = db();
  return d.all<Row>('SELECT * FROM work_centers ORDER BY name').map((w) => ({
    ...w,
    pending_mos: d.value<number>("SELECT COUNT(DISTINCT mo_id) FROM job_cards jc JOIN manufacturing_orders mo ON mo.id = jc.mo_id WHERE jc.work_center_id = ? AND jc.status <> 'completed' AND mo.status IN ('confirmed','in_progress')", w.id),
    active_job_cards: d.value<number>("SELECT COUNT(*) FROM job_cards WHERE work_center_id = ? AND status = 'in_progress'", w.id),
    completed_mos: d.value<number>("SELECT COUNT(DISTINCT mo_id) FROM job_cards jc JOIN manufacturing_orders mo ON mo.id = jc.mo_id WHERE jc.work_center_id = ? AND mo.status = 'completed'", w.id),
    load_minutes: r2(d.value<number>("SELECT COALESCE(SUM(planned_minutes - actual_minutes),0) FROM job_cards WHERE work_center_id = ? AND status <> 'completed'", w.id) ?? 0),
  }));
}

// ---------------- Bills of materials ----------------

export function saveBom(input: Row, user?: AuthUser, id?: number) {
  return db().tx(() => {
    const d = db();
    const item = d.get<Row>('SELECT * FROM items WHERE id = ?', input.item_id) ?? fail('Finished item not found', 422);
    if (!isStockItem(item)) fail('The finished item must be an inventory-tracked good', 422);
    const quantity = Number(input.quantity ?? 1);
    if (!(quantity > 0)) fail('Output quantity must be greater than zero', 422);
    const comps: Row[] = input.components ?? [];
    if (!comps.length) fail('Add at least one component', 422);
    for (const c of comps) {
      const ci = d.get<Row>('SELECT * FROM items WHERE id = ?', c.item_id) ?? fail('Component item not found', 422);
      if (ci.id === item.id) fail('An item cannot be a component of itself', 422);
      if (!(Number(c.qty) > 0)) fail(`Quantity for ${ci.name} must be greater than zero`, 422);
      if (Number(c.wastage_pct ?? 0) < 0 || Number(c.wastage_pct ?? 0) >= 100) fail('Wastage must be between 0 and 100%', 422);
      // Prevent direct cycles: a component whose default BOM uses the finished item.
      if (d.get('SELECT 1 FROM boms b JOIN bom_components bc ON bc.bom_id = b.id WHERE b.item_id = ? AND bc.item_id = ?', ci.id, item.id)) fail(`${ci.name} already uses ${item.name} in its BOM (circular)`, 422);
    }
    const ops: Row[] = input.operations ?? [];
    for (const o of ops) {
      if (!d.get('SELECT 1 FROM work_centers WHERE id = ?', o.work_center_id)) fail('Work centre not found', 422);
      if (Number(o.minutes) < 0) fail('Operation time cannot be negative', 422);
    }
    const row = { name: String(input.name ?? '').trim() || `BOM for ${item.name}`, item_id: item.id, quantity, overhead_cost: Math.max(0, Number(input.overhead_cost) || 0), is_default: input.is_default === false ? 0 : 1, status: input.status === 'inactive' ? 'inactive' : 'active', notes: input.notes ?? null };
    if (row.is_default) d.run('UPDATE boms SET is_default = 0 WHERE item_id = ? AND id <> ?', item.id, id ?? -1);
    let bid = id;
    if (id) {
      d.get('SELECT 1 FROM boms WHERE id = ?', id) ?? fail('BOM not found', 404);
      d.update('boms', id, row);
      d.run('DELETE FROM bom_components WHERE bom_id = ?', id);
      d.run('DELETE FROM bom_operations WHERE bom_id = ?', id);
    } else bid = d.insert('boms', { ...row, number: nextNumber('bom') });
    for (const c of comps) d.insert('bom_components', { bom_id: bid, item_id: c.item_id, qty: Number(c.qty), wastage_pct: Number(c.wastage_pct ?? 0) });
    ops.forEach((o, i) => d.insert('bom_operations', { bom_id: bid, seq: i + 1, name: String(o.name ?? `Operation ${i + 1}`), work_center_id: o.work_center_id, minutes: Number(o.minutes) || 0 }));
    audit('bom', bid!, id ? 'updated' : 'created', `BOM ${row.name}`, user);
    return bid!;
  });
}

export function getBom(id: number) {
  const d = db();
  const b = d.get<Row>('SELECT b.*, i.name AS item_name, i.unit FROM boms b JOIN items i ON i.id = b.item_id WHERE b.id = ?', id) ?? fail('BOM not found', 404);
  const components = d.all<Row>(
    `SELECT bc.*, i.name AS item_name, i.unit, i.purchase_rate,
       (SELECT CASE WHEN SUM(qty) > 0 THEN SUM(value)/SUM(qty) END FROM stock_moves WHERE item_id = bc.item_id AND accounting = 1) AS avg_cost
     FROM bom_components bc JOIN items i ON i.id = bc.item_id WHERE bc.bom_id = ?`, id);
  const operations = d.all<Row>('SELECT o.*, w.name AS work_center_name, w.cost_per_hour FROM bom_operations o JOIN work_centers w ON w.id = o.work_center_id WHERE o.bom_id = ? ORDER BY o.seq', id);
  const material = r2(components.reduce((a, c) => a + c.qty * (1 + c.wastage_pct / 100) * (c.avg_cost ?? c.purchase_rate ?? 0), 0));
  const labour = r2(operations.reduce((a, o) => a + (o.minutes / 60) * o.cost_per_hour, 0));
  return { ...b, components, operations, cost: { material, labour, overhead: b.overhead_cost, total: r2(material + labour + b.overhead_cost), per_unit: r2((material + labour + b.overhead_cost) / b.quantity) } };
}

export function deleteBom(id: number) {
  if (db().get('SELECT 1 FROM manufacturing_orders WHERE bom_id = ?', id)) fail('This BOM is used by manufacturing orders. Mark it inactive instead.', 422);
  db().run('DELETE FROM boms WHERE id = ?', id);
}

// ---------------- Manufacturing orders ----------------

export function saveMo(input: Row, user?: AuthUser, id?: number) {
  return db().tx(() => {
    const d = db();
    const existing = id ? d.get<Row>('SELECT * FROM manufacturing_orders WHERE id = ?', id) ?? fail('Manufacturing order not found', 404) : null;
    if (existing && existing.status !== 'draft') fail('Only draft manufacturing orders can be edited', 422);
    const bom = d.get<Row>("SELECT * FROM boms WHERE id = ? AND status = 'active'", input.bom_id ?? existing?.bom_id) ?? fail('Active BOM not found', 422);
    const qty = Number(input.qty ?? existing?.qty);
    if (!(qty > 0)) fail('Quantity to manufacture must be greater than zero', 422);
    const date = input.date ?? existing?.date ?? today();
    if (!isDate(date)) fail('Date is invalid', 422);
    const warehouse_id = input.warehouse_id ?? existing?.warehouse_id ?? primaryWarehouse();
    if (!d.get('SELECT 1 FROM warehouses WHERE id = ?', warehouse_id)) fail('Warehouse not found', 422);
    if (input.sales_order_id && !d.get("SELECT 1 FROM documents WHERE id = ? AND type = 'sales_order'", input.sales_order_id)) fail('Sales order not found', 422);
    const row = {
      date, bom_id: bom.id, item_id: bom.item_id, qty, warehouse_id, planned_start: input.planned_start ?? date, planned_end: input.planned_end ?? null,
      sales_order_id: input.sales_order_id ?? existing?.sales_order_id ?? null, notes: input.notes ?? null,
      overhead_cost: r2(bom.overhead_cost * qty / bom.quantity),
    };
    let mid = id;
    if (id) { d.update('manufacturing_orders', id, row); d.run('DELETE FROM mo_components WHERE mo_id = ?', id); }
    else mid = d.insert('manufacturing_orders', { ...row, number: nextNumber('manufacturing_order'), status: 'draft', created_by: user?.id ?? null });
    for (const c of d.all<Row>('SELECT * FROM bom_components WHERE bom_id = ?', bom.id)) {
      d.insert('mo_components', { mo_id: mid, item_id: c.item_id, required_qty: r4((c.qty * qty / bom.quantity) * (1 + c.wastage_pct / 100)) });
    }
    audit('mo', mid!, id ? 'updated' : 'created', `Manufacturing order for ${qty} unit(s)`, user);
    return mid!;
  });
}

export function materialAvailability(moId: number) {
  const d = db();
  const mo = d.get<Row>('SELECT * FROM manufacturing_orders WHERE id = ?', moId)!;
  return d.all<Row>('SELECT c.*, i.name AS item_name, i.unit, i.tracking FROM mo_components c JOIN items i ON i.id = c.item_id WHERE c.mo_id = ?', moId).map((c) => {
    const onHand = d.value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = ? AND warehouse_id = ? AND physical = 1', c.item_id, mo.warehouse_id) ?? 0;
    const reservedByOthers = d.value<number>(
      "SELECT COALESCE(SUM(mc.required_qty - mc.consumed_qty),0) FROM mo_components mc JOIN manufacturing_orders m ON m.id = mc.mo_id WHERE mc.item_id = ? AND m.id <> ? AND m.status IN ('confirmed','in_progress')", c.item_id, moId) ?? 0;
    const available = r2(onHand - reservedByOthers);
    return { ...c, on_hand: r2(onHand), reserved_elsewhere: r2(reservedByOthers), available, shortage: r2(Math.max(0, c.required_qty - c.consumed_qty - available)) };
  });
}

export function confirmMo(id: number, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const mo = d.get<Row>('SELECT * FROM manufacturing_orders WHERE id = ?', id) ?? fail('Manufacturing order not found', 404);
    if (mo.status !== 'draft') fail('Only draft orders can be confirmed', 422);
    const ops = d.all<Row>('SELECT * FROM bom_operations WHERE bom_id = ? ORDER BY seq', mo.bom_id);
    const bom = d.get<Row>('SELECT * FROM boms WHERE id = ?', mo.bom_id)!;
    let cursor = Date.parse((mo.planned_start ?? mo.date) + 'T09:00:00Z');
    for (const o of ops) {
      const minutes = r2(o.minutes * mo.qty / bom.quantity);
      d.insert('job_cards', { number: nextNumber('job_card'), mo_id: id, seq: o.seq, name: o.name, work_center_id: o.work_center_id, planned_minutes: minutes, planned_start: new Date(cursor).toISOString().slice(0, 16) });
      cursor += minutes * 60000;
    }
    const plannedEnd = new Date(cursor).toISOString().slice(0, 10);
    d.update('manufacturing_orders', id, { status: 'confirmed', planned_end: mo.planned_end ?? plannedEnd });
    audit('mo', id, 'confirmed', `Manufacturing order ${mo.number} released with ${ops.length} job card(s)`, user);
    return { shortages: materialAvailability(id).filter((c) => c.shortage > 0) };
  });
}

function closeOpenLog(jobCardId: number) {
  const d = db();
  const log = d.get<Row>('SELECT * FROM job_card_logs WHERE job_card_id = ? AND ended_at IS NULL', jobCardId);
  if (!log) return;
  const ended = new Date().toISOString();
  const minutes = r2(Math.max(0, (Date.parse(ended) - Date.parse(log.started_at)) / 60000));
  d.update('job_card_logs', log.id, { ended_at: ended, minutes });
}
function syncJobMinutes(jobCardId: number) {
  const d = db();
  const total = d.value<number>('SELECT COALESCE(SUM(minutes),0) FROM job_card_logs WHERE job_card_id = ?', jobCardId) ?? 0;
  d.update('job_cards', jobCardId, { actual_minutes: r2(total) });
}

export function jobCardAction(id: number, action: string, body: Row, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const jc = d.get<Row>('SELECT * FROM job_cards WHERE id = ?', id) ?? fail('Job card not found', 404);
    const mo = d.get<Row>('SELECT * FROM manufacturing_orders WHERE id = ?', jc.mo_id)!;
    if (!['confirmed', 'in_progress'].includes(mo.status)) fail('The manufacturing order is not released', 422);
    if (action === 'start') {
      if (!['pending', 'paused'].includes(jc.status)) fail('Job card is already running or completed', 422);
      const prev = d.get<Row>("SELECT * FROM job_cards WHERE mo_id = ? AND seq < ? AND status <> 'completed' ORDER BY seq LIMIT 1", jc.mo_id, jc.seq);
      if (prev && !body.force) fail(`Complete the previous operation "${prev.name}" first`, 422);
      if (body.employee_id && !d.get('SELECT 1 FROM employees WHERE id = ?', body.employee_id)) fail('Employee not found', 422);
      d.insert('job_card_logs', { job_card_id: id, started_at: new Date().toISOString(), employee_id: body.employee_id ?? jc.employee_id ?? null });
      d.update('job_cards', id, { status: 'in_progress', started_at: jc.started_at ?? new Date().toISOString(), employee_id: body.employee_id ?? jc.employee_id ?? null });
      if (mo.status === 'confirmed') d.update('manufacturing_orders', mo.id, { status: 'in_progress' });
    } else if (action === 'pause') {
      if (jc.status !== 'in_progress') fail('Job card is not running', 422);
      closeOpenLog(id);
      syncJobMinutes(id);
      d.update('job_cards', id, { status: 'paused' });
    } else if (action === 'complete') {
      if (jc.status === 'completed') fail('Job card is already completed', 422);
      closeOpenLog(id);
      if (body.minutes != null) {
        const m = Number(body.minutes);
        if (!(m >= 0)) fail('Minutes cannot be negative', 422);
        d.insert('job_card_logs', { job_card_id: id, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), minutes: m, employee_id: body.employee_id ?? jc.employee_id ?? null, notes: 'Manual time entry' });
      }
      syncJobMinutes(id);
      d.update('job_cards', id, { status: 'completed', completed_at: new Date().toISOString(), notes: body.notes ?? jc.notes });
      if (mo.status === 'confirmed') d.update('manufacturing_orders', mo.id, { status: 'in_progress' });
    } else if (action === 'log_time') {
      const m = Number(body.minutes);
      if (!(m > 0)) fail('Minutes must be greater than zero', 422);
      d.insert('job_card_logs', { job_card_id: id, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), minutes: m, employee_id: body.employee_id ?? null, notes: body.notes ?? null });
      syncJobMinutes(id);
    } else if (action === 'assign') {
      if (body.employee_id && !d.get('SELECT 1 FROM employees WHERE id = ?', body.employee_id)) fail('Employee not found', 422);
      d.update('job_cards', id, { employee_id: body.employee_id || null });
    } else fail('Unknown job card action', 404);
    audit('job_card', id, action, `Job card ${jc.number}: ${action}`, user);
    return id;
  });
}

const qcRequired = (itemId: number, where: 'manufacturing' | 'purchase_receive') =>
  !!db().get("SELECT 1 FROM quality_rules WHERE item_id = ? AND is_active = 1 AND applies_to IN (?, 'both')", itemId, where);

export function completeMo(id: number, body: Row, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const mo = d.get<Row>('SELECT * FROM manufacturing_orders WHERE id = ?', id) ?? fail('Manufacturing order not found', 404);
    if (!['confirmed', 'in_progress'].includes(mo.status)) fail('Only released orders can be completed', 422);
    const date = body.date ?? today();
    if (!isDate(date) || date < mo.date) fail('Completion date must be on or after the order date', 422);
    assertUnlocked('inventory', date, 'manufacturing order');
    const openCards = d.all<Row>("SELECT * FROM job_cards WHERE mo_id = ? AND status <> 'completed'", id);
    if (openCards.length) {
      if (!body.auto_complete_job_cards) fail(`Complete all job cards first (${openCards.length} open)`, 422);
      for (const jc of openCards) {
        closeOpenLog(jc.id);
        syncJobMinutes(jc.id);
        const actual = d.value<number>('SELECT actual_minutes FROM job_cards WHERE id = ?', jc.id) ?? 0;
        if (!actual) d.insert('job_card_logs', { job_card_id: jc.id, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), minutes: jc.planned_minutes, notes: 'Auto-completed at planned time' });
        syncJobMinutes(jc.id);
        d.update('job_cards', jc.id, { status: 'completed', completed_at: new Date().toISOString() });
      }
    }
    let produced = Number(body.produced_qty ?? mo.qty);
    let rejected = Number(body.rejected_qty ?? 0);
    if (qcRequired(mo.item_id, 'manufacturing')) {
      const qi = d.get<Row>("SELECT * FROM quality_inspections WHERE source_type = 'mo' AND source_id = ? AND status IN ('passed','failed','partial') ORDER BY id DESC LIMIT 1", id);
      if (!qi) fail('This item requires a quality inspection before the order can be completed', 422);
      produced = qi!.accepted_qty;
      rejected = qi!.rejected_qty;
    }
    if (produced < 0 || rejected < 0 || produced + rejected <= 0) fail('Produced quantity must be greater than zero', 422);
    const ratio = (produced + rejected) / mo.qty;
    const comps = d.all<Row>('SELECT c.*, i.tracking, i.type, i.track_inventory FROM mo_components c JOIN items i ON i.id = c.item_id WHERE c.mo_id = ?', id);
    const consumption: Row = Object.fromEntries((body.consumption ?? []).map((c: Row) => [c.component_id, c]));
    const moves: MoveSpec[] = [];
    for (const c of comps) {
      const given = consumption[c.id];
      const qty = r4(given?.qty != null ? Number(given.qty) : c.required_qty * ratio);
      if (qty < 0) fail('Consumed quantity cannot be negative', 422);
      d.update('mo_components', c.id, { consumed_qty: qty, tracking: JSON.stringify(given?.tracking ?? []) });
      if (qty > 0 && c.type === 'goods' && c.track_inventory) {
        let tracking: Row[] = given?.tracking ?? [];
        if (!tracking.length && c.tracking === 'batch') {
          // Auto-allocate batches first-expiry-first-out when the user did not pick them.
          let need = qty;
          for (const b of availableBatches(c.item_id, mo.warehouse_id)) {
            if (need <= 1e-9) break;
            const take = Math.min(need, b.qty);
            tracking.push({ batch_no: b.batch_no, qty: r4(take), expiry_date: b.expiry_date });
            need = r4(need - take);
          }
          if (need > 1e-9) fail(`Not enough batch stock of component #${c.item_id} in the warehouse`, 422);
        }
        if (!tracking.length && c.tracking === 'serial') fail('Select serial numbers for serial-tracked components', 422);
        moves.push(...splitTracking({ item_id: c.item_id, warehouse_id: mo.warehouse_id, date, qty: -qty, kind: 'mo_consume', source_line_id: c.id }, tracking, c.tracking));
      }
    }
    const fg = d.get<Row>('SELECT * FROM items WHERE id = ?', mo.item_id)!;
    if (produced > 0) moves.push(...splitTracking({ item_id: mo.item_id, warehouse_id: mo.warehouse_id, date, qty: produced, kind: 'mo_produce' }, body.output_tracking ?? [], fg.tracking));
    const labour = r2(d.all<Row>('SELECT jc.actual_minutes, jc.planned_minutes, w.cost_per_hour FROM job_cards jc JOIN work_centers w ON w.id = jc.work_center_id WHERE jc.mo_id = ?', id)
      .reduce((a, j) => a + ((j.actual_minutes || j.planned_minutes) / 60) * j.cost_per_hour, 0));
    d.update('manufacturing_orders', id, { status: 'completed', completed_date: date, produced_qty: produced, rejected_qty: rejected, labour_cost: labour, output_tracking: JSON.stringify(body.output_tracking ?? []) });
    const items = setMoves('mo', id, moves);
    validateStock('mo', id);
    revalueItems(items, `mo:${id}`);
    postMoJournal(id);
    const material = -(d.value<number>("SELECT COALESCE(SUM(value),0) FROM stock_moves WHERE source_type = 'mo' AND source_id = ? AND kind = 'mo_consume'", id) ?? 0);
    d.update('manufacturing_orders', id, { material_cost: r2(material) });
    if (mo.sales_order_id) afterSave(mo.sales_order_id, user, '');
    audit('mo', id, 'completed', `Manufacturing order ${mo.number} completed: ${produced} produced, ${rejected} rejected`, user);
    if (mo.created_by) notify([mo.created_by], `Manufacturing order ${mo.number} completed`, `${produced} ${fg.unit} of ${fg.name} produced`, `/manufacturing/orders/${id}`);
    return id;
  });
}

export function postMoJournal(id: number) {
  const d = db();
  const mo = d.get<Row>('SELECT * FROM manufacturing_orders WHERE id = ?', id);
  if (!mo || mo.status !== 'completed') return replaceJournal('mo', id, null);
  const lines: JLine[] = [];
  for (const g of d.all<Row>(
    `SELECT m.item_id, i.inventory_account_id, SUM(m.value) AS value FROM stock_moves m JOIN items i ON i.id = m.item_id
     WHERE m.source_type = 'mo' AND m.source_id = ? AND m.accounting = 1 GROUP BY m.item_id, m.kind`, id)) {
    const v = r2(g.value);
    if (!v) continue;
    lines.push({ account_id: g.inventory_account_id || acct('inventory_asset'), debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0, item_id: g.item_id });
  }
  const net = r2(lines.reduce((a, l) => a + (l.debit ?? 0) - (l.credit ?? 0), 0));
  if (net) lines.push({ account_id: acct('mfg_absorption'), credit: net > 0 ? net : 0, debit: net < 0 ? -net : 0, description: 'Labour and overhead absorbed into finished goods' });
  replaceJournal('mo', id, { date: mo.completed_date, memo: `Manufacturing order ${mo.number}`, reference: mo.number, lines });
}

export function cancelMo(id: number, user?: AuthUser) {
  db().tx(() => {
    const d = db();
    const mo = d.get<Row>('SELECT * FROM manufacturing_orders WHERE id = ?', id) ?? fail('Manufacturing order not found', 404);
    if (mo.status === 'completed') fail('Completed orders cannot be cancelled. Reverse with an inventory adjustment.', 422);
    if (mo.status === 'cancelled') fail('Already cancelled', 422);
    d.update('manufacturing_orders', id, { status: 'cancelled' });
    d.run("UPDATE job_cards SET status = 'cancelled' WHERE mo_id = ? AND status <> 'completed'", id);
    audit('mo', id, 'cancelled', `Manufacturing order ${mo.number} cancelled`, user);
  });
}

export function deleteMo(id: number, user?: AuthUser) {
  const mo = db().get<Row>('SELECT * FROM manufacturing_orders WHERE id = ?', id) ?? fail('Manufacturing order not found', 404);
  if (!['draft', 'cancelled'].includes(mo.status)) fail('Only draft or cancelled orders can be deleted', 422);
  db().run('DELETE FROM manufacturing_orders WHERE id = ?', id);
  audit('mo', id, 'deleted', `Manufacturing order ${mo.number} deleted`, user);
}

export function getMo(id: number) {
  const d = db();
  const mo = d.get<Row>(
    `SELECT mo.*, i.name AS item_name, i.unit, i.tracking AS item_tracking, b.number AS bom_number, b.name AS bom_name, w.name AS warehouse_name, so.number AS sales_order_number
     FROM manufacturing_orders mo JOIN items i ON i.id = mo.item_id JOIN boms b ON b.id = mo.bom_id JOIN warehouses w ON w.id = mo.warehouse_id
     LEFT JOIN documents so ON so.id = mo.sales_order_id WHERE mo.id = ?`, id) ?? fail('Manufacturing order not found', 404);
  const job_cards = d.all<Row>(
    `SELECT jc.*, w.name AS work_center_name, w.cost_per_hour, e.name AS employee_name FROM job_cards jc JOIN work_centers w ON w.id = jc.work_center_id
     LEFT JOIN employees e ON e.id = jc.employee_id WHERE jc.mo_id = ? ORDER BY jc.seq`, id);
  const inspections = d.all<Row>("SELECT * FROM quality_inspections WHERE source_type = 'mo' AND source_id = ? ORDER BY id", id);
  const total = r2(mo.material_cost + mo.labour_cost + mo.overhead_cost);
  return {
    ...mo, output_tracking: json(mo.output_tracking, []), components: materialAvailability(id).map((c) => ({ ...c, tracking: json(c.tracking, []) })), job_cards, inspections,
    qc_required: qcRequired(mo.item_id, 'manufacturing'),
    cost: { material: mo.material_cost, labour: mo.labour_cost, overhead: mo.overhead_cost, total, per_unit: mo.produced_qty ? r2(total / mo.produced_qty) : 0 },
    journal: journalsFor('mo', id),
    stock_moves: d.all<Row>(`SELECT m.*, i.name AS item_name FROM stock_moves m JOIN items i ON i.id = m.item_id WHERE m.source_type = 'mo' AND m.source_id = ?`, id),
  };
}

export function listMos(q: Row) {
  const where = ['1=1'];
  const params: unknown[] = [];
  if (q.status) { where.push('mo.status = ?'); params.push(q.status); }
  if (q.search) { where.push('(mo.number LIKE ? OR i.name LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
  return db().all<Row>(
    `SELECT mo.*, i.name AS item_name, i.unit, w.name AS warehouse_name,
       (SELECT COUNT(*) FROM job_cards WHERE mo_id = mo.id) AS job_cards, (SELECT COUNT(*) FROM job_cards WHERE mo_id = mo.id AND status = 'completed') AS job_cards_done
     FROM manufacturing_orders mo JOIN items i ON i.id = mo.item_id JOIN warehouses w ON w.id = mo.warehouse_id
     WHERE ${where.join(' AND ')} ORDER BY mo.date DESC, mo.id DESC LIMIT 500`, ...params);
}

/** Creates draft manufacturing orders for sales order lines whose items have an active default BOM. */
export function mosFromSalesOrder(soId: number, user?: AuthUser) {
  const d = db();
  const so = d.get<Row>("SELECT * FROM documents WHERE id = ? AND type = 'sales_order'", soId) ?? fail('Sales order not found', 404);
  if (so.status !== 'confirmed') fail('Confirm the sales order first', 422);
  const created: number[] = [];
  for (const l of d.all<Row>('SELECT * FROM document_lines WHERE document_id = ?', soId)) {
    const bom = d.get<Row>("SELECT * FROM boms WHERE item_id = ? AND status = 'active' ORDER BY is_default DESC, id LIMIT 1", l.item_id);
    if (!bom) continue;
    const already = d.value<number>("SELECT COALESCE(SUM(qty),0) FROM manufacturing_orders WHERE sales_order_id = ? AND item_id = ? AND status <> 'cancelled'", soId, l.item_id) ?? 0;
    const qty = r4(l.qty - already);
    if (qty <= 0) continue;
    created.push(saveMo({ bom_id: bom.id, qty, sales_order_id: soId, warehouse_id: l.warehouse_id || so.warehouse_id, notes: `For ${so.number}` }, user));
  }
  if (!created.length) fail('No lines on this order need manufacturing (no BOM or already planned)', 422);
  return created;
}

export function shopFloor() {
  const d = db();
  return d.all<Row>('SELECT * FROM work_centers WHERE is_active = 1 ORDER BY name').map((w) => ({
    ...w,
    job_cards: d.all<Row>(
      `SELECT jc.*, mo.number AS mo_number, mo.qty AS mo_qty, i.name AS item_name, e.name AS employee_name FROM job_cards jc
       JOIN manufacturing_orders mo ON mo.id = jc.mo_id JOIN items i ON i.id = mo.item_id LEFT JOIN employees e ON e.id = jc.employee_id
       WHERE jc.work_center_id = ? AND jc.status IN ('pending','in_progress','paused') AND mo.status IN ('confirmed','in_progress')
       ORDER BY jc.planned_start, jc.id`, w.id),
  }));
}

/** Work centre calendar: planned job card load per day. */
export function workCenterCalendar(from: string, to: string) {
  return db().all<Row>(
    `SELECT jc.id, jc.number, jc.name, jc.status, jc.planned_start, jc.planned_minutes, jc.actual_minutes, jc.work_center_id, w.name AS work_center_name,
            w.capacity_hours, mo.number AS mo_number, i.name AS item_name
     FROM job_cards jc JOIN work_centers w ON w.id = jc.work_center_id JOIN manufacturing_orders mo ON mo.id = jc.mo_id JOIN items i ON i.id = mo.item_id
     WHERE substr(jc.planned_start, 1, 10) BETWEEN ? AND ? AND jc.status <> 'cancelled' ORDER BY jc.planned_start`, from, to);
}

/** Material requirements planning: demand from orders vs. supply, with buy/make suggestions. */
export function mrp() {
  const d = db();
  const items = d.all<Row>("SELECT * FROM items WHERE type = 'goods' AND track_inventory = 1 AND is_active = 1");
  return items.map((i) => {
    const onHand = d.value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = ? AND physical = 1', i.id) ?? 0;
    const soDemand = Math.max(0, committedQty(i.id));
    const moDemand = d.value<number>("SELECT COALESCE(SUM(mc.required_qty - mc.consumed_qty),0) FROM mo_components mc JOIN manufacturing_orders m ON m.id = mc.mo_id WHERE mc.item_id = ? AND m.status IN ('draft','confirmed','in_progress')", i.id) ?? 0;
    const poSupply = Math.max(0, incomingQty(i.id));
    const moSupply = d.value<number>("SELECT COALESCE(SUM(qty),0) FROM manufacturing_orders WHERE item_id = ? AND status IN ('draft','confirmed','in_progress')", i.id) ?? 0;
    const demand = r2(soDemand + moDemand + i.reorder_level);
    const supply = r2(onHand + poSupply + moSupply);
    const shortage = r2(Math.max(0, demand - supply));
    const bom = d.get<Row>("SELECT id FROM boms WHERE item_id = ? AND status = 'active' LIMIT 1", i.id);
    return { item_id: i.id, name: i.name, sku: i.sku, unit: i.unit, on_hand: r2(onHand), so_demand: r2(soDemand), mo_demand: r2(moDemand), reorder_level: i.reorder_level, po_supply: r2(poSupply), mo_supply: r2(moSupply), shortage, action: shortage > 0 ? (bom ? 'make' : 'buy') : null, bom_id: bom?.id ?? null, preferred_vendor_id: i.preferred_vendor_id };
  }).filter((r) => r.so_demand || r.mo_demand || r.shortage || r.po_supply || r.mo_supply);
}

// ---------------- Quality ----------------

export function saveQualityRule(input: Row, id?: number) {
  const d = db();
  const item = d.get<Row>('SELECT * FROM items WHERE id = ?', input.item_id) ?? fail('Item not found', 422);
  const params: Row[] = input.parameters ?? [];
  if (!params.length) fail('Add at least one inspection parameter', 422);
  for (const p of params) {
    if (!String(p.name ?? '').trim()) fail('Parameter name is required', 422);
    if (p.type === 'numeric' && p.min != null && p.max != null && Number(p.min) > Number(p.max)) fail(`Min exceeds max for ${p.name}`, 422);
  }
  const row = { name: String(input.name ?? '').trim() || `${item.name} QC`, item_id: item.id, applies_to: ['manufacturing', 'purchase_receive', 'both'].includes(input.applies_to) ? input.applies_to : 'both', parameters: JSON.stringify(params), is_active: input.is_active === false || input.is_active === 0 ? 0 : 1 };
  if (id) { d.update('quality_rules', id, row); return id; }
  return d.insert('quality_rules', row);
}

export function createInspection(input: Row, user?: AuthUser) {
  const d = db();
  const qty = Number(input.qty);
  if (!(qty > 0)) fail('Inspection quantity must be greater than zero', 422);
  if (input.source_type === 'mo') {
    const mo = d.get<Row>('SELECT * FROM manufacturing_orders WHERE id = ?', input.source_id) ?? fail('Manufacturing order not found', 404);
    if (!['confirmed', 'in_progress'].includes(mo.status)) fail('Inspections can be raised for released orders only', 422);
    input.item_id = mo.item_id;
  } else if (input.source_type === 'purchase_receive') {
    const line = d.get<Row>('SELECT l.* FROM document_lines l JOIN documents doc ON doc.id = l.document_id WHERE l.id = ? AND doc.id = ?', input.source_line_id, input.source_id) ?? fail('Receive line not found', 404);
    input.item_id = line.item_id;
  } else fail('Unknown inspection source', 422);
  const id = d.insert('quality_inspections', { number: nextNumber('inspection'), date: input.date ?? today(), source_type: input.source_type, source_id: input.source_id, source_line_id: input.source_line_id ?? null, item_id: input.item_id, qty, inspector: input.inspector ?? user?.name ?? null });
  audit('inspection', id, 'created', `Quality inspection raised for ${qty} unit(s)`, user);
  return id;
}

/** Creates pending inspections for receive lines whose items have QC rules. */
export function ensureReceiveInspections(receiveId: number, user?: AuthUser) {
  const d = db();
  for (const l of d.all<Row>('SELECT * FROM document_lines WHERE document_id = ?', receiveId)) {
    if (!l.item_id || !qcRequired(l.item_id, 'purchase_receive')) continue;
    if (d.get("SELECT 1 FROM quality_inspections WHERE source_type = 'purchase_receive' AND source_line_id = ?", l.id)) continue;
    createInspection({ source_type: 'purchase_receive', source_id: receiveId, source_line_id: l.id, qty: l.qty }, user);
  }
}

export function recordInspection(id: number, input: Row, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const qi = d.get<Row>('SELECT * FROM quality_inspections WHERE id = ?', id) ?? fail('Inspection not found', 404);
    if (qi.status !== 'pending') fail('This inspection is already recorded', 422);
    if (qi.source_type === 'purchase_receive' && d.value<string>('SELECT status FROM documents WHERE id = ?', qi.source_id) !== 'pending_inspection') {
      fail('The receive for this inspection is no longer awaiting inspection', 422);
    }
    const accepted = Number(input.accepted_qty), rejected = Number(input.rejected_qty ?? qi.qty - accepted);
    if (!(accepted >= 0 && rejected >= 0) || Math.abs(accepted + rejected - qi.qty) > 1e-9) fail(`Accepted + rejected must equal the inspected quantity (${qi.qty})`, 422);
    const rules = d.all<Row>("SELECT * FROM quality_rules WHERE item_id = ? AND is_active = 1", qi.item_id).flatMap((r) => json<Row[]>(r.parameters, []));
    const results: Row[] = (input.results ?? []).map((r: Row) => {
      const p = rules.find((x) => x.name === r.parameter);
      let pass = r.pass;
      if (p?.type === 'numeric' && r.value != null && r.value !== '') {
        const v = Number(r.value);
        pass = (p.min == null || p.min === '' || v >= Number(p.min)) && (p.max == null || p.max === '' || v <= Number(p.max));
      }
      return { parameter: r.parameter, value: r.value ?? null, pass: !!pass };
    });
    const status = rejected === 0 ? 'passed' : accepted === 0 ? 'failed' : 'partial';
    d.update('quality_inspections', id, { accepted_qty: accepted, rejected_qty: rejected, results: JSON.stringify(results), status, inspector: input.inspector ?? qi.inspector, notes: input.notes ?? null });
    if (qi.source_type === 'purchase_receive') {
      d.update('document_lines', qi.source_line_id, { qty2: accepted });
      const pending = d.get("SELECT 1 FROM quality_inspections WHERE source_type = 'purchase_receive' AND source_id = ? AND status = 'pending'", qi.source_id);
      if (!pending) {
        d.update('documents', qi.source_id, { status: 'received' });
        afterSave(qi.source_id, user, 'inspected');
      }
    }
    audit('inspection', id, 'recorded', `Inspection ${qi.number}: ${accepted} accepted, ${rejected} rejected`, user);
    return status;
  });
}

export function listInspections(q: Row) {
  return db().all<Row>(
    `SELECT qi.*, i.name AS item_name, COALESCE(doc.number, mo.number) AS source_number FROM quality_inspections qi JOIN items i ON i.id = qi.item_id
     LEFT JOIN documents doc ON doc.id = qi.source_id AND qi.source_type = 'purchase_receive' LEFT JOIN manufacturing_orders mo ON mo.id = qi.source_id AND qi.source_type = 'mo'
     ${q.status ? 'WHERE qi.status = ?' : ''} ORDER BY qi.id DESC LIMIT 500`, ...(q.status ? [q.status] : []));
}

export function getInspection(id: number) {
  const d = db();
  const qi = d.get<Row>('SELECT qi.*, i.name AS item_name FROM quality_inspections qi JOIN items i ON i.id = qi.item_id WHERE qi.id = ?', id) ?? fail('Inspection not found', 404);
  const parameters = d.all<Row>('SELECT * FROM quality_rules WHERE item_id = ? AND is_active = 1', qi.item_id).flatMap((r) => json<Row[]>(r.parameters, []));
  return { ...qi, results: json(qi.results, []), parameters };
}
