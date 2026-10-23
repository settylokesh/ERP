import { audit, history, notify, queueEmail, runWorkflows, usersInRoles, adminUsers } from '../activity.js';
import { assertCan, can, type AuthUser } from '../auth.js';
import { db, fail, json, type Row } from '../db.js';
import { journalsFor } from '../ledger.js';
import { assertUnlocked, getKv, nextNumber, org } from '../settings.js';
import { computeTaxLine, computeTds, supplyKind } from '../tax.js';
import { addDays, isDate, r2, today, num, STATES } from '../util.js';
import { buildMoves, isPosted, loadFull, syncPosting, type FullDoc } from './posting.js';
import { DOC_TYPES, docType, type DocTypeDef } from './types.js';

export interface LineInput {
  id?: number;
  item_id?: number | null;
  account_id?: number | null;
  description?: string;
  hsn_code?: string;
  unit?: string;
  qty?: number;
  qty2?: number | null;
  rate?: number;
  discount_pct?: number;
  tax_id?: number | null;
  tax_exempt?: string | null;
  ref_line_id?: number | null;
  warehouse_id?: number | null;
  itc_eligible?: boolean;
  tracking?: any[];
  data?: Row;
}
export interface DocInput {
  date?: string;
  due_date?: string | null;
  contact_id?: number | null;
  warehouse_id?: number | null;
  to_warehouse_id?: number | null;
  currency_code?: string;
  exchange_rate?: number;
  place_of_supply?: string | null;
  reference?: string | null;
  salesperson?: string | null;
  payment_terms?: number | null;
  ref_doc_id?: number | null;
  notes?: string | null;
  terms?: string | null;
  adjustment?: number;
  tax_inclusive?: boolean;
  reverse_charge?: boolean;
  data?: Row;
  custom?: Row;
  lines?: LineInput[];
}

const DRAFTLESS = new Set(['package', 'sales_return', 'purchase_receive']);
export const approvalConfig = (type: string): { mode: 'none' | 'simple' | 'multi'; levels: number[] } =>
  getKv<Record<string, any>>('approvals', {})[type] ?? { mode: 'none', levels: [] };

export const primaryWarehouse = () =>
  db().value<number>('SELECT id FROM warehouses WHERE is_active = 1 ORDER BY is_primary DESC, id LIMIT 1');

/** Quantity of a parent line already consumed by child documents of the given type(s). */
export function consumedQty(parentLineId: number, childTypes: string[], excludeDocId?: number, statuses?: string[]): number {
  const st = statuses ?? [];
  return db().value<number>(
    `SELECT COALESCE(SUM(l.qty), 0) FROM document_lines l JOIN documents d ON d.id = l.document_id
     WHERE l.ref_line_id = ? AND d.type IN (${childTypes.map(() => '?').join(',')}) AND d.status NOT IN ('void','returned')
       AND (? IS NULL OR d.id <> ?) ${st.length ? `AND d.status IN (${st.map(() => '?').join(',')})` : ''}`,
    parentLineId, ...childTypes, excludeDocId ?? null, excludeDocId ?? null, ...st) ?? 0;
}

/** Which child types consume a parent line's quantity, by (child, parent) pair. */
const CONSUMES: Record<string, Record<string, string[]>> = {
  package: { sales_order: ['package'] },
  delivery_challan: { sales_order: ['delivery_challan', 'package'] },
  invoice: { sales_order: ['invoice'], delivery_challan: ['invoice'] },
  credit_note: { invoice: ['credit_note'], sales_return: ['credit_note'] },
  sales_return: { sales_order: ['sales_return'], invoice: ['sales_return'] },
  purchase_receive: { purchase_order: ['purchase_receive'] },
  bill: { purchase_order: ['bill'] },
  vendor_credit: { bill: ['vendor_credit'] },
};

function validateParty(def: DocTypeDef, contactId: number | null | undefined): Row | undefined {
  if (!contactId) {
    if (def.partyRequired) fail(`${def.party === 'vendor' ? 'Vendor' : 'Customer'} is required`, 422);
    return undefined;
  }
  const c = db().get<Row>('SELECT * FROM contacts WHERE id = ?', contactId);
  if (!c) fail('Contact not found', 422);
  if (def.party && c!.kind !== def.party) fail(`Selected contact is not a ${def.party}`, 422);
  return c;
}

/** Normalises input, applies defaults from contact/items and computes GST + totals. */
export function prepare(type: string, input: DocInput, existing?: Row) {
  const def = docType(type);
  const o = org();
  const d = db();
  const date = input.date ?? existing?.date ?? today();
  if (!isDate(date)) fail('A valid date is required', 422);
  const contact = validateParty(def, input.contact_id ?? null);
  const data: Row = { ...json<Row>(existing?.data, {}), ...(input.data ?? {}) };
  let warehouse_id = input.warehouse_id ?? null;
  if (def.warehouse && !warehouse_id) warehouse_id = primaryWarehouse() ?? null;
  if (warehouse_id && !d.get('SELECT 1 FROM warehouses WHERE id = ?', warehouse_id)) fail('Warehouse not found', 422);
  if (type === 'transfer_order') {
    if (!input.to_warehouse_id) fail('Destination warehouse is required', 422);
    if (input.to_warehouse_id === warehouse_id) fail('Source and destination warehouses must be different', 422);
  }
  const payment_terms = input.payment_terms ?? contact?.payment_terms ?? 0;
  let due_date = input.due_date ?? null;
  if (def.dueDate && !due_date) due_date = addDays(date, Number(payment_terms) || 0);
  if (due_date && !isDate(due_date)) fail('Due date is invalid', 422);
  if (due_date && due_date < date) fail('Due date cannot be before the document date', 422);

  const gst_treatment = contact?.gst_treatment ?? null;
  let place_of_supply = input.place_of_supply ?? contact?.place_of_supply ?? o.state_code;
  if (place_of_supply && !STATES[place_of_supply]) fail('Place of supply is invalid', 422);
  if (gst_treatment === 'overseas') place_of_supply = '96';
  const currency_code = input.currency_code ?? contact?.currency_code ?? 'INR';
  const exchange_rate = currency_code === 'INR' ? 1 : Number(input.exchange_rate ?? d.value<number>('SELECT rate FROM currencies WHERE code = ?', currency_code) ?? 1);
  if (!(exchange_rate > 0)) fail('Exchange rate must be positive', 422);
  const reverse_charge = !!input.reverse_charge && def.side === 'purchase';
  const tax_inclusive = !!input.tax_inclusive && def.priced;
  const ourState = (warehouse_id && d.value<string>('SELECT state_code FROM warehouses WHERE id = ?', warehouse_id)) || o.state_code;
  const kind = def.priced
    ? supplyKind({ ourState, placeOfSupply: place_of_supply, gstTreatment: gst_treatment, side: def.side === 'purchase' ? 'purchase' : 'sales', withPayment: !!data.export_with_payment, reverseCharge: reverse_charge })
    : 'none';

  const rawLines = input.lines ?? [];
  if (!rawLines.length) fail('Add at least one line item', 422);
  const lines: Row[] = [];
  rawLines.forEach((li, idx) => {
    const item = li.item_id ? d.get<Row>('SELECT * FROM items WHERE id = ?', li.item_id) : undefined;
    if (li.item_id && !item) fail(`Line ${idx + 1}: item not found`, 422);
    if (!item && !li.account_id && !li.description) fail(`Line ${idx + 1}: choose an item or account`, 422);
    if (item && !item.is_active && !li.id) fail(`Line ${idx + 1}: item "${item.name}" is inactive`, 422);
    if (li.account_id && !d.get('SELECT 1 FROM accounts WHERE id = ?', li.account_id)) fail(`Line ${idx + 1}: account not found`, 422);
    const qty = num(li.qty, def.priced || type === 'retainer_invoice' ? 1 : 0);
    if (type === 'inventory_adjustment') {
      if (data.mode !== 'value' && qty === 0) fail(`Line ${idx + 1}: adjusted quantity cannot be zero`, 422);
    } else if (type === 'stock_count') {
      if (qty < 0) fail(`Line ${idx + 1}: quantity cannot be negative`, 422);
    } else if (!(qty > 0)) fail(`Line ${idx + 1}: quantity must be greater than zero`, 422);
    const rate = num(li.rate, item ? (def.side === 'purchase' ? item.purchase_rate : def.side === 'sales' ? item.sales_rate : 0) : 0);
    if (rate < 0) fail(`Line ${idx + 1}: rate cannot be negative`, 422);
    const discount_pct = num(li.discount_pct, 0);
    if (discount_pct < 0 || discount_pct > 100) fail(`Line ${idx + 1}: discount must be between 0 and 100%`, 422);
    let tax_id = li.tax_id !== undefined ? li.tax_id : item?.tax_id ?? null;
    let tax_exempt = li.tax_exempt ?? (item && item.tax_preference !== 'taxable' ? item.tax_preference : null);
    if (!def.priced) { tax_id = null; tax_exempt = null; }
    const tax = tax_id ? d.get<Row>('SELECT * FROM taxes WHERE id = ?', tax_id) : undefined;
    if (tax_id && !tax) fail(`Line ${idx + 1}: tax not found`, 422);
    const calc = computeTaxLine({ qty, rate, discount_pct, tax_rate: tax?.rate ?? 0, tax_exempt }, def.priced ? kind : 'none', tax_inclusive);
    lines.push({
      id: li.id, line_no: idx + 1, item_id: item?.id ?? null, account_id: li.account_id ?? null,
      description: li.description ?? item?.description ?? item?.name ?? '', hsn_code: li.hsn_code ?? item?.hsn_code ?? null,
      unit: li.unit ?? item?.unit ?? null, qty, qty2: li.qty2 ?? null, rate, discount_pct, tax_id, tax_rate: calc.tax_rate,
      tax_exempt: def.priced && (kind === 'zero_rated' || kind === 'none') && !tax_exempt ? (kind === 'zero_rated' ? 'zero_rated' : 'non_gst') : tax_exempt,
      taxable: calc.taxable, cgst: calc.cgst, sgst: calc.sgst, igst: calc.igst, cess: 0, amount: calc.taxable, landed_cost: 0,
      ref_line_id: li.ref_line_id ?? null, warehouse_id: li.warehouse_id ?? null,
      itc_eligible: li.itc_eligible === false ? 0 : 1, tracking: JSON.stringify(li.tracking ?? []), data: JSON.stringify(li.data ?? {}),
      _item: item, _discount: calc.discount,
    });
  });

  // Landed costs: account lines flagged as landed cost are capitalised into stock lines (by value or quantity).
  if (type === 'bill') {
    const landed = lines.filter((l) => json<Row>(l.data, {}).landed_cost);
    const targets = lines.filter((l) => l._item && l._item.type === 'goods' && l._item.track_inventory);
    if (landed.length && targets.length) {
      const pool = r2(landed.reduce((a, l) => a + l.taxable + (l.itc_eligible ? 0 : l.cgst + l.sgst + l.igst), 0));
      const byQty = data.landed_method === 'quantity';
      const basis = targets.reduce((a, l) => a + (byQty ? l.qty : l.taxable), 0) || 1;
      let left = pool;
      targets.forEach((l, i) => {
        const share = i === targets.length - 1 ? left : r2((pool * (byQty ? l.qty : l.taxable)) / basis);
        l.landed_cost = share;
        left = r2(left - share);
      });
    }
  }
  if (type === 'stock_count' || type === 'inventory_adjustment' || type === 'transfer_order' || type === 'package' || type === 'purchase_receive') {
    for (const l of lines) if (!l.item_id) fail(`${def.plural} need an item on every line`, 422);
  }
  if (type === 'inventory_adjustment' && data.mode === 'value') {
    for (const l of lines) {
      if (l.qty2 == null || !Number.isFinite(Number(l.qty2)) || Number(l.qty2) < 0) fail(`Line ${l.line_no}: enter the new stock value`, 422);
      const cur = d.value<number>(
        `SELECT COALESCE(SUM(value),0) FROM stock_moves WHERE item_id = ? AND accounting = 1 AND date <= ?
         AND NOT (source_type = 'inventory_adjustment' AND source_id = ?)`, l.item_id, date, existing?.id ?? -1) ?? 0;
      l.data = JSON.stringify({ ...json<Row>(l.data, {}), current_value: r2(cur), value_delta: r2(Number(l.qty2) - cur) });
    }
  }

  const taxable_total = r2(lines.reduce((a, l) => a + l.taxable, 0));
  const discount_total = r2(lines.reduce((a, l) => a + l._discount, 0));
  const subtotal = taxable_total;
  const cgst_total = r2(lines.reduce((a, l) => a + l.cgst, 0));
  const sgst_total = r2(lines.reduce((a, l) => a + l.sgst, 0));
  const igst_total = r2(lines.reduce((a, l) => a + l.igst, 0));
  const tax_total = r2(cgst_total + sgst_total + igst_total);
  const adjustment = r2(num(input.adjustment, 0));
  let tds_amount = 0;
  if (type === 'bill' && data.tds_section_id) {
    const sec = d.get<Row>('SELECT * FROM tds_sections WHERE id = ?', data.tds_section_id);
    if (!sec) fail('TDS section not found', 422);
    tds_amount = computeTds(taxable_total, sec!.rate);
    data.tds_rate = sec!.rate;
    data.tds_section = sec!.section;
  }
  const total = r2(taxable_total + (reverse_charge ? 0 : tax_total) + adjustment - tds_amount);
  if (def.priced && total < 0) fail('Total cannot be negative', 422);
  if (type === 'expense' && !data.paid_through_account_id) fail('Choose the account the expense was paid through', 422);

  return {
    def,
    header: {
      date, due_date, contact_id: contact?.id ?? null, warehouse_id, to_warehouse_id: input.to_warehouse_id ?? null,
      currency_code, exchange_rate, place_of_supply: def.priced || def.party ? place_of_supply : null, gst_treatment,
      gstin: contact?.gstin ?? null, reverse_charge: reverse_charge ? 1 : 0, tax_inclusive: tax_inclusive ? 1 : 0,
      reference: input.reference ?? null, salesperson: input.salesperson ?? null, payment_terms,
      ref_doc_id: input.ref_doc_id ?? existing?.ref_doc_id ?? null, notes: input.notes ?? null, terms: input.terms ?? null,
      subtotal, discount_total, taxable_total, cgst_total, sgst_total, igst_total, cess_total: 0, tax_total, tds_amount,
      adjustment, total, data: JSON.stringify(data), custom: JSON.stringify(input.custom ?? json(existing?.custom, {})),
    },
    lines,
  };
}

function validateRefs(type: string, header: Row, lines: Row[], docId?: number) {
  const d = db();
  if (!header.ref_doc_id) {
    if (lines.some((l) => l.ref_line_id)) fail('Line references require a source document', 422);
    return;
  }
  const parent = d.get<Row>('SELECT * FROM documents WHERE id = ?', header.ref_doc_id);
  if (!parent) fail('Source document not found', 422);
  const def = docType(type);
  if (!def.from.includes(parent!.type)) fail(`A ${def.label} cannot be created from a ${DOC_TYPES[parent!.type].label}`, 422);
  if (['void', 'draft', 'cancelled', 'pending_approval', 'rejected'].includes(parent!.status)) {
    fail(`The source ${DOC_TYPES[parent!.type].label} must be active`, 422);
  }
  if (parent!.contact_id && header.contact_id && DOC_TYPES[parent!.type].party === def.party && parent!.contact_id !== header.contact_id) {
    fail('Contact must match the source document', 422);
  }
  const consumers = CONSUMES[type]?.[parent!.type];
  for (const l of lines) {
    if (!l.ref_line_id) continue;
    const pl = d.get<Row>('SELECT * FROM document_lines WHERE id = ?', l.ref_line_id);
    if (!pl || pl.document_id !== parent!.id) fail(`Line ${l.line_no} does not belong to ${parent!.number}`, 422);
    if (pl!.item_id && l.item_id && pl!.item_id !== l.item_id) fail(`Line ${l.line_no}: item differs from the source line`, 422);
    if (!consumers) continue;
    let limit = pl!.qty;
    if (type === 'sales_return' && parent!.type === 'sales_order') {
      limit = consumedQty(pl!.id, ['package'], undefined, ['shipped', 'delivered']) + consumedQty(pl!.id, ['delivery_challan']);
    }
    if (type === 'credit_note' && parent!.type === 'sales_return') limit = pl!.qty;
    const used = consumedQty(pl!.id, consumers, docId);
    if (l.qty > r2(limit - used) + 1e-9) {
      fail(`Line ${l.line_no}: quantity ${l.qty} exceeds the remaining ${r2(limit - used)} on ${parent!.number}`, 422);
    }
  }
}

function writeLines(docId: number, lines: Row[], isUpdate: boolean) {
  const d = db();
  const keep = new Set<number>();
  for (const l of lines) {
    const { _item, _discount, id, ...row } = l;
    void _item; void _discount;
    if (isUpdate && id && d.get('SELECT 1 FROM document_lines WHERE id = ? AND document_id = ?', id, docId)) {
      d.update('document_lines', id, row);
      keep.add(id);
    } else {
      keep.add(d.insert('document_lines', { ...row, document_id: docId }));
    }
  }
  if (isUpdate) {
    for (const old of d.all<{ id: number }>('SELECT id FROM document_lines WHERE document_id = ?', docId)) {
      if (keep.has(old.id)) continue;
      if (d.get('SELECT 1 FROM document_lines WHERE ref_line_id = ?', old.id)) fail('A line that is referenced by another transaction cannot be removed', 422);
      d.run('DELETE FROM rfq_bids WHERE line_id = ?', old.id);
      d.run('DELETE FROM document_lines WHERE id = ?', old.id);
    }
  }
}

function initialStatus(def: DocTypeDef, submit: boolean, lines: Row[]): string {
  if (def.type === 'purchase_receive') {
    const needsQc = lines.some((l) => l.item_id && db().get(
      "SELECT 1 FROM quality_rules WHERE item_id = ? AND is_active = 1 AND applies_to IN ('purchase_receive','both')", l.item_id));
    return needsQc ? 'pending_inspection' : 'received';
  }
  if (DRAFTLESS.has(def.type)) return def.activeStatus;
  if (!submit) return 'draft';
  if (def.approvable && approvalConfig(def.type).mode !== 'none') return 'pending_approval';
  return def.activeStatus;
}

const recordFor = (doc: Row) => {
  const c = doc.contact_id ? db().get<Row>('SELECT name, email FROM contacts WHERE id = ?', doc.contact_id) : undefined;
  return { ...doc, contact_name: c?.name, contact_email: c?.email, link: `/docs/${doc.type}/${doc.id}` };
};

export function createDocument(type: string, input: DocInput, user: AuthUser | undefined, opts: { submit?: boolean } = {}) {
  const def = docType(type);
  return db().tx(() => {
    const { header, lines } = prepare(type, input);
    assertUnlocked(def.lock, header.date, def.label);
    validateRefs(type, header, lines);
    const status = initialStatus(def, !!opts.submit, lines);
    const number = nextNumber(type);
    const id = db().insert('documents', {
      ...header, type, number, status, created_by: user?.id ?? null, balance: def.priced || type === 'retainer_invoice' ? header.total : 0,
    });
    writeLines(id, lines, false);
    afterSave(id, user, 'created');
    if (status === 'pending_approval') requestApproval(id, user);
    runWorkflows(type, 'on_create', recordFor(db().get<Row>('SELECT * FROM documents WHERE id = ?', id)!), user);
    return id;
  });
}

export function updateDocument(id: number, input: DocInput, user: AuthUser | undefined, opts: { submit?: boolean } = {}) {
  return db().tx(() => {
    const existing = db().get<Row>('SELECT * FROM documents WHERE id = ?', id) ?? fail('Document not found', 404);
    const def = docType(existing.type);
    if (['void', 'closed', 'invoiced', 'ordered', 'transferred', 'completed', 'credited', 'cancelled', 'adjusted'].includes(existing.status) && existing.type !== 'purchase_receive') {
      fail(`A ${def.statuses[existing.status] ?? existing.status} ${def.label.toLowerCase()} cannot be edited`, 422);
    }
    const ed = json<Row>(existing.data, {});
    if (ed.einvoice?.status === 'generated') fail('Cancel the e-invoice (IRN) before editing this document', 422);
    assertUnlocked(def.lock, existing.date, def.label);
    const { header, lines } = prepare(existing.type, input, existing);
    assertUnlocked(def.lock, header.date, def.label);
    validateRefs(existing.type, header, lines, id);
    let status = existing.status;
    if (existing.status === 'draft' && opts.submit) status = initialStatus(def, true, lines);
    if (existing.status === 'pending_approval') status = 'pending_approval';
    db().update('documents', id, { ...header, status, updated_at: new Date().toISOString() });
    writeLines(id, lines, true);
    if (['invoice', 'bill', 'retainer_invoice'].includes(existing.type) && header.total < paidAmount(id) - 0.001) {
      fail('Total cannot be less than the amount already paid or credited', 422);
    }
    afterSave(id, user, 'updated');
    if (status === 'pending_approval' && existing.status === 'draft') requestApproval(id, user);
    runWorkflows(existing.type, 'on_update', recordFor(db().get<Row>('SELECT * FROM documents WHERE id = ?', id)!), user);
    return id;
  });
}

/** Posting + derived status refresh after any change to a document. */
export function afterSave(id: number, user: AuthUser | undefined, verb: string) {
  syncPosting(id);
  refreshBalance(id);
  const doc = db().get<Row>('SELECT * FROM documents WHERE id = ?', id)!;
  if (doc.ref_doc_id) refreshParent(doc.ref_doc_id);
  if (doc.type === 'sales_order' || doc.type === 'purchase_order') refreshParent(id);
  if (verb) audit(doc.type, id, verb, `${DOC_TYPES[doc.type].label} ${doc.number} ${verb} (${doc.status})`, user);
}

export function paidAmount(docId: number): number {
  const d = db();
  const alloc = d.value<number>(`SELECT COALESCE(SUM(a.amount),0) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.document_id = ? AND p.status <> 'void'`, docId) ?? 0;
  const credits = d.value<number>('SELECT COALESCE(SUM(amount),0) FROM credit_applications WHERE document_id = ?', docId) ?? 0;
  return r2(alloc + credits);
}
export function creditUsed(docId: number): number {
  const d = db();
  return r2((d.value<number>('SELECT COALESCE(SUM(amount),0) FROM credit_applications WHERE credit_doc_id = ?', docId) ?? 0)
    + (d.value<number>('SELECT COALESCE(SUM(amount),0) FROM refunds WHERE credit_doc_id = ?', docId) ?? 0));
}

export function refreshBalance(id: number) {
  const d = db();
  const doc = d.get<Row>('SELECT * FROM documents WHERE id = ?', id);
  if (!doc) return;
  const live = !['draft', 'pending_approval', 'void', 'rejected'].includes(doc.status);
  if (['invoice', 'bill', 'retainer_invoice'].includes(doc.type)) {
    const paid = paidAmount(id);
    const balance = r2(doc.total - paid);
    let status = doc.status;
    if (live) status = balance <= 0.004 ? 'paid' : paid > 0 ? 'partially_paid' : 'open';
    if (doc.type === 'retainer_invoice' && status === 'partially_paid') status = 'open';
    d.update('documents', id, { balance: Math.max(0, balance), status });
  } else if (['credit_note', 'vendor_credit'].includes(doc.type)) {
    const balance = r2(doc.total - creditUsed(id));
    let status = doc.status;
    if (live) status = balance <= 0.004 ? 'closed' : 'open';
    d.update('documents', id, { balance: Math.max(0, balance), status });
  }
}

/** Recomputes fulfilment / billing progress of orders and conversion statuses of upstream documents. */
export function refreshParent(parentId: number) {
  const d = db();
  const p = d.get<Row>('SELECT * FROM documents WHERE id = ?', parentId);
  if (!p) return;
  const lines = d.all<Row>('SELECT * FROM document_lines WHERE document_id = ?', parentId);
  const goods = new Set(d.all<{ id: number }>("SELECT id FROM items WHERE type = 'goods'").map((r) => r.id));
  const progress = (types: string[], statuses?: string[], goodsOnly = false) => {
    let done = 0, total = 0;
    for (const l of lines) {
      if (!l.item_id && p.type !== 'purchase_order') continue;
      if (goodsOnly && !goods.has(l.item_id)) continue;
      total += l.qty;
      done += Math.min(l.qty, consumedQty(l.id, types, undefined, statuses));
    }
    return total <= 0 ? 0 : done / total;
  };
  const label = (ratio: number, none: string, part: string, all: string) => (ratio <= 1e-9 ? none : ratio >= 1 - 1e-9 ? all : part);
  if (p.type === 'sales_order') {
    const shipped = progress(['package', 'delivery_challan'], ['shipped', 'delivered', 'open', 'invoiced'], true);
    const invoiced = progress(['invoice']);
    const fulfil_status = label(shipped, 'pending', 'partially_shipped', 'shipped');
    const billing_status = label(invoiced, 'not_invoiced', 'partially_invoiced', 'invoiced');
    let status = p.status;
    if (p.status === 'confirmed' && shipped >= 1 - 1e-9 && invoiced >= 1 - 1e-9) status = 'closed';
    else if (p.status === 'closed' && !json<Row>(p.data, {}).manually_closed && (shipped < 1 - 1e-9 || invoiced < 1 - 1e-9)) status = 'confirmed';
    d.update('documents', parentId, { fulfil_status, billing_status, status });
  } else if (p.type === 'purchase_order') {
    const received = progress(['purchase_receive'], undefined, true);
    const billed = progress(['bill']);
    const fulfil_status = label(received, 'not_received', 'partially_received', 'received');
    const billing_status = label(billed, 'not_billed', 'partially_billed', 'billed');
    let status = p.status;
    if (p.status === 'issued' && received >= 1 - 1e-9 && billed >= 1 - 1e-9) status = 'closed';
    else if (p.status === 'closed' && !json<Row>(p.data, {}).manually_closed && (received < 1 - 1e-9 || billed < 1 - 1e-9)) status = 'issued';
    d.update('documents', parentId, { fulfil_status, billing_status, status });
  } else {
    const children = d.all<Row>("SELECT type, status FROM documents WHERE ref_doc_id = ? AND status NOT IN ('void')", parentId);
    const has = (t: string) => children.some((c) => c.type === t);
    let status = p.status;
    if (p.type === 'quote') {
      if (has('invoice')) status = 'invoiced';
      else if (has('sales_order')) status = 'accepted';
    } else if (p.type === 'purchase_request' && (has('purchase_order') || has('rfq'))) status = 'ordered';
    else if (p.type === 'rfq' && has('purchase_order')) status = 'ordered';
    else if (p.type === 'delivery_challan' && has('invoice')) status = 'invoiced';
    else if (p.type === 'sales_return' && has('credit_note')) status = 'credited';
    else if (p.type === 'stock_count' && has('inventory_adjustment')) status = 'completed';
    if (status !== p.status) d.update('documents', parentId, { status });
  }
}

// ---------------- Approvals ----------------

function requestApproval(id: number, user?: AuthUser) {
  const doc = db().get<Row>('SELECT * FROM documents WHERE id = ?', id)!;
  const cfg = approvalConfig(doc.type);
  db().update('documents', id, { approval_level: 0 });
  db().insert('approval_history', { entity: doc.type, entity_id: id, level: 0, action: 'submitted', user_id: user?.id ?? null });
  const approvers = cfg.mode === 'multi' && cfg.levels.length ? usersInRoles([cfg.levels[0]]) : approverIds(doc.type);
  notify(approvers.filter((x) => x !== user?.id), `${DOC_TYPES[doc.type].label} ${doc.number} awaits your approval`, '', `/docs/${doc.type}/${id}`);
}
function approverIds(type: string): number[] {
  const module = DOC_TYPES[type].module;
  return db().all<Row>('SELECT u.id, r.is_admin, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.is_active = 1')
    .filter((u) => u.is_admin || json<Row>(u.permissions, {})[module]?.approve).map((u) => u.id);
}
export function canApprove(doc: Row, user?: AuthUser): boolean {
  if (!user || doc.status !== 'pending_approval') return false;
  const cfg = approvalConfig(doc.type);
  if (user.is_admin) return true;
  if (cfg.mode === 'multi' && cfg.levels.length) return cfg.levels[doc.approval_level] === user.role_id;
  return can(user, DOC_TYPES[doc.type].module, 'approve');
}

// ---------------- Read ----------------

export function displayStatus(doc: Row): string {
  if (['open', 'partially_paid'].includes(doc.status) && ['invoice', 'bill'].includes(doc.type) && doc.due_date && doc.due_date < today()) return 'overdue';
  if (doc.type === 'quote' && doc.status === 'sent' && doc.due_date && doc.due_date < today()) return 'expired';
  return doc.status;
}

export function listDocuments(type: string, q: Row) {
  docType(type);
  const where: string[] = ['d.type = ?'];
  const params: unknown[] = [type];
  if (q.status) {
    if (q.status === 'overdue') {
      where.push("d.status IN ('open','partially_paid') AND d.due_date < ?");
      params.push(today());
    } else if (q.status === 'unpaid') {
      where.push("d.status IN ('open','partially_paid')");
    } else {
      where.push('d.status = ?');
      params.push(q.status);
    }
  }
  if (q.contact_id) { where.push('d.contact_id = ?'); params.push(q.contact_id); }
  if (q.from) { where.push('d.date >= ?'); params.push(q.from); }
  if (q.to) { where.push('d.date <= ?'); params.push(q.to); }
  if (q.search) {
    where.push('(d.number LIKE ? OR d.reference LIKE ? OR c.name LIKE ?)');
    params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
  }
  if (q.ref_doc_id) { where.push('d.ref_doc_id = ?'); params.push(q.ref_doc_id); }
  const limit = Math.min(Number(q.limit) || 200, 1000);
  const offset = Number(q.offset) || 0;
  const sortCol = ({ number: 'd.number', total: 'd.total', contact: 'c.name', due_date: 'd.due_date' } as Row)[q.sort] ?? 'd.date';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const rows = db().all<Row>(
    `SELECT d.id, d.type, d.number, d.date, d.due_date, d.status, d.fulfil_status, d.billing_status, d.total, d.balance,
            d.currency_code, d.reference, d.contact_id, c.name AS contact_name, d.warehouse_id, w.name AS warehouse_name,
            d.to_warehouse_id, d.ref_doc_id, d.data, d.created_at
     FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN warehouses w ON w.id = d.warehouse_id
     WHERE ${where.join(' AND ')} ORDER BY ${sortCol} ${dir}, d.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = db().value<number>(`SELECT COUNT(*) FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id WHERE ${where.join(' AND ')}`, ...params);
  return {
    rows: rows.map((r) => {
      const data = json<Row>(r.data, {});
      return { ...r, data: undefined, display_status: displayStatus(r), einvoice: data.einvoice?.status ?? null, ewaybill: data.ewaybill?.status ?? null };
    }),
    total,
  };
}

export function getDocument(id: number, user?: AuthUser) {
  const d = db();
  const doc = loadFull(id) ?? fail('Document not found', 404);
  const def = docType(doc.type);
  const contact = doc.contact_id ? d.get<Row>('SELECT * FROM contacts WHERE id = ?', doc.contact_id) : null;
  const lines = doc.lines.map((l) => {
    const extra: Row = {};
    for (const [child, parents] of Object.entries(CONSUMES)) {
      if (parents[doc.type]) extra[`${child}_qty`] = r2(consumedQty(l.id, parents[doc.type]));
    }
    return { ...l, tracking: json(l.tracking, []), data: json(l.data, {}), ...extra };
  });
  const related = d.all<Row>(
    `SELECT id, type, number, date, status, total FROM documents WHERE ref_doc_id = ? OR id = ? ORDER BY date, id`,
    id, doc.ref_doc_id ?? -1).filter((r) => r.id !== id);
  const payments = d.all<Row>(
    `SELECT p.id, p.kind, p.number, p.date, p.mode, a.amount, p.status FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
     WHERE a.document_id = ? ORDER BY p.date`, id);
  const credits = d.all<Row>(
    `SELECT ca.id, ca.amount, ca.date, ca.credit_doc_id, ca.payment_id, cd.number AS credit_number, cd.type AS credit_type,
            inv.number AS document_number, inv.id AS document_id, inv.type AS document_type, p.number AS payment_number
     FROM credit_applications ca LEFT JOIN documents cd ON cd.id = ca.credit_doc_id LEFT JOIN documents inv ON inv.id = ca.document_id
     LEFT JOIN payments p ON p.id = ca.payment_id WHERE ca.document_id = ? OR ca.credit_doc_id = ?`, id, id);
  const refunds = d.all<Row>('SELECT r.*, a.name AS account_name FROM refunds r JOIN accounts a ON a.id = r.account_id WHERE r.credit_doc_id = ?', id);
  const bids = doc.type === 'rfq' ? d.all<Row>(
    'SELECT b.*, c.name AS vendor_name FROM rfq_bids b JOIN contacts c ON c.id = b.vendor_id WHERE b.rfq_id = ? ORDER BY b.line_id, b.rate', id) : [];
  const out = {
    ...doc,
    data: json<Row>(doc.data, {}),
    custom: json<Row>(doc.custom, {}),
    lines,
    contact,
    warehouse_name: doc.warehouse_id ? d.value<string>('SELECT name FROM warehouses WHERE id = ?', doc.warehouse_id) : null,
    to_warehouse_name: doc.to_warehouse_id ? d.value<string>('SELECT name FROM warehouses WHERE id = ?', doc.to_warehouse_id) : null,
    ref_doc: doc.ref_doc_id ? d.get<Row>('SELECT id, type, number FROM documents WHERE id = ?', doc.ref_doc_id) : null,
    display_status: displayStatus(doc),
    status_label: def.statuses[doc.status] ?? doc.status,
    related, payments, credits, refunds, bids,
    credit_available: doc.type === 'retainer_invoice' ? r2(doc.total - doc.balance - creditUsed(id)) : null,
    journal: journalsFor(doc.type, id),
    stock_moves: d.all<Row>(`SELECT m.*, i.name AS item_name, w.name AS warehouse_name FROM stock_moves m JOIN items i ON i.id = m.item_id
       JOIN warehouses w ON w.id = m.warehouse_id WHERE m.source_type = ? AND m.source_id = ? ORDER BY m.id`, doc.type, id),
    approvals: d.all<Row>('SELECT h.*, u.name AS user_name FROM approval_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.entity = ? AND h.entity_id = ? ORDER BY h.id', doc.type, id),
    history: history(doc.type, id),
    comments: d.all<Row>('SELECT c.*, u.name AS user_name FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.entity = ? AND c.entity_id = ? ORDER BY c.id', doc.type, id),
    can_approve: canApprove(doc, user),
    org: org(),
  };
  return out;
}

// ---------------- Delete / void ----------------

export function deleteDocument(id: number, user?: AuthUser) {
  db().tx(() => {
    const doc = db().get<Row>('SELECT * FROM documents WHERE id = ?', id) ?? fail('Document not found', 404);
    const def = docType(doc.type);
    assertUnlocked(def.lock, doc.date, def.label);
    const kids = db().value<number>("SELECT COUNT(*) FROM documents WHERE ref_doc_id = ? AND status <> 'void'", id);
    if (kids) fail(`This ${def.label.toLowerCase()} has ${kids} linked transaction(s). Delete or void them first.`, 422);
    if (paidAmount(id) > 0 || creditUsed(id) > 0) fail('Remove payments, applied credits and refunds before deleting', 422);
    if (json<Row>(doc.data, {}).einvoice?.status === 'generated') fail('Cancel the e-invoice before deleting', 422);
    if (db().get("SELECT 1 FROM manufacturing_orders WHERE sales_order_id = ? AND status <> 'cancelled'", id)) fail('Cancel linked manufacturing orders first', 422);
    db().run("DELETE FROM credit_applications WHERE credit_doc_id = ? OR document_id = ?", id, id);
    db().update('documents', id, { status: 'void' });
    syncPosting(id); // removes stock moves and journals
    db().run('DELETE FROM documents WHERE id = ?', id);
    if (doc.ref_doc_id) refreshParent(doc.ref_doc_id);
    audit(doc.type, id, 'deleted', `${def.label} ${doc.number} deleted`, user);
  });
}

export function voidDocument(id: number, user?: AuthUser, reason?: string) {
  db().tx(() => {
    const doc = db().get<Row>('SELECT * FROM documents WHERE id = ?', id) ?? fail('Document not found', 404);
    const def = docType(doc.type);
    if (!def.statuses.void) fail(`${def.plural} cannot be voided`, 422);
    if (doc.status === 'void') fail('Already void', 422);
    assertUnlocked(def.lock, doc.date, def.label);
    if (paidAmount(id) > 0 || creditUsed(id) > 0) fail('Remove payments, applied credits and refunds before voiding', 422);
    const kids = db().value<number>("SELECT COUNT(*) FROM documents WHERE ref_doc_id = ? AND status <> 'void' AND type <> 'package'", id);
    if (kids && doc.type !== 'invoice') fail('Void the linked transactions first', 422);
    if (json<Row>(doc.data, {}).einvoice?.status === 'generated') fail('Cancel the e-invoice (IRN) before voiding', 422);
    const data = { ...json<Row>(doc.data, {}), void_reason: reason ?? null };
    db().update('documents', id, { status: 'void', balance: 0, data: JSON.stringify(data) });
    syncPosting(id);
    if (doc.ref_doc_id) refreshParent(doc.ref_doc_id);
    audit(doc.type, id, 'voided', `${def.label} ${doc.number} voided${reason ? `: ${reason}` : ''}`, user);
  });
}

// ---------------- Status transitions ----------------

export function setStatus(id: number, status: string, user?: AuthUser, extraData?: Row, verb?: string) {
  const doc = db().get<Row>('SELECT * FROM documents WHERE id = ?', id) ?? fail('Document not found', 404);
  const def = docType(doc.type);
  assertUnlocked(def.lock, doc.date, def.label);
  const data = { ...json<Row>(doc.data, {}), ...(extraData ?? {}) };
  db().update('documents', id, { status, data: JSON.stringify(data), updated_at: new Date().toISOString() });
  afterSave(id, user, '');
  audit(doc.type, id, verb ?? 'status', `${def.label} ${doc.number} marked ${def.statuses[status] ?? status}`, user);
  runWorkflows(doc.type, 'on_status_change', recordFor(db().get<Row>('SELECT * FROM documents WHERE id = ?', id)!), user);
}

export function submitDocument(id: number, user?: AuthUser) {
  const doc = db().get<Row>('SELECT * FROM documents WHERE id = ?', id) ?? fail('Document not found', 404);
  if (doc.status !== 'draft' && doc.status !== 'rejected') fail('Only drafts can be submitted', 422);
  const def = docType(doc.type);
  const needs = def.approvable && approvalConfig(doc.type).mode !== 'none';
  db().tx(() => {
    setStatus(id, needs ? 'pending_approval' : def.activeStatus, user, undefined, 'submitted');
    if (needs) requestApproval(id, user);
  });
}

export function approveDocument(id: number, user: AuthUser | undefined, comment?: string) {
  db().tx(() => {
    const doc = db().get<Row>('SELECT * FROM documents WHERE id = ?', id) ?? fail('Document not found', 404);
    if (doc.status !== 'pending_approval') fail('This document is not awaiting approval', 422);
    if (!canApprove(doc, user)) fail('You are not an approver for this level', 403);
    const def = docType(doc.type);
    const cfg = approvalConfig(doc.type);
    const level = doc.approval_level + 1;
    db().insert('approval_history', { entity: doc.type, entity_id: id, level, action: 'approved', user_id: user?.id ?? null, comment: comment ?? null });
    const final = !(cfg.mode === 'multi' && cfg.levels.length > level) || user?.is_admin;
    if (final) {
      db().update('documents', id, { approval_level: level });
      setStatus(id, def.activeStatus, user, undefined, 'approved');
      if (doc.created_by) notify([doc.created_by], `${def.label} ${doc.number} was approved`, comment ?? '', `/docs/${doc.type}/${id}`);
    } else {
      db().update('documents', id, { approval_level: level });
      notify(usersInRoles([cfg.levels[level]]), `${def.label} ${doc.number} awaits your approval (level ${level + 1})`, '', `/docs/${doc.type}/${id}`);
      audit(doc.type, id, 'approved', `Level ${level} approval by ${user?.name}`, user);
    }
  });
}

export function rejectDocument(id: number, user: AuthUser | undefined, comment?: string) {
  db().tx(() => {
    const doc = db().get<Row>('SELECT * FROM documents WHERE id = ?', id) ?? fail('Document not found', 404);
    if (!canApprove(doc, user)) fail('You are not an approver for this document', 403);
    db().insert('approval_history', { entity: doc.type, entity_id: id, level: doc.approval_level + 1, action: 'rejected', user_id: user?.id ?? null, comment: comment ?? null });
    setStatus(id, doc.type === 'purchase_request' ? 'rejected' : 'draft', user, undefined, 'rejected');
    if (doc.created_by) notify([doc.created_by], `${DOC_TYPES[doc.type].label} ${doc.number} was rejected`, comment ?? '', `/docs/${doc.type}/${id}`);
  });
}

// ---------------- Conversions ----------------

/** Builds an unsaved draft of `toType` prefilled from a source document (only remaining quantities). */
export function convertDraft(fromId: number, toType: string, opts: Row = {}): DocInput & { type: string } {
  const d = db();
  const src = loadFull(fromId) ?? fail('Source document not found', 404);
  const def = docType(toType);
  if (!def.from.includes(src.type)) fail(`Cannot create a ${def.label} from a ${DOC_TYPES[src.type].label}`, 422);
  const consumers = CONSUMES[toType]?.[src.type];
  const sameParty = DOC_TYPES[src.type].party === def.party;
  let refDocId: number = src.id;
  let lines: LineInput[] = [];
  const srcData = json<Row>(src.data, {});
  if (toType === 'bill' && src.type === 'purchase_receive') {
    // Bills reference the purchase order lines behind a receive.
    refDocId = src.ref_doc_id ?? fail('Receive is not linked to a purchase order', 422);
    lines = src.lines.map((l) => {
      const po = d.get<Row>('SELECT * FROM document_lines WHERE id = ?', l.ref_line_id)!;
      const remaining = r2(po.qty - consumedQty(po.id, ['bill']));
      return { item_id: l.item_id, description: po.description, qty: Math.min(l.qty2 ?? l.qty, remaining), rate: po.rate, discount_pct: po.discount_pct, tax_id: po.tax_id, ref_line_id: po.id, account_id: po.account_id };
    }).filter((l) => (l.qty ?? 0) > 0);
  } else {
    lines = src.lines.map((l) => {
      let qty = l.qty;
      if (consumers) {
        let limit = l.qty;
        if (toType === 'sales_return' && src.type === 'sales_order') limit = consumedQty(l.id, ['package'], undefined, ['shipped', 'delivered']) + consumedQty(l.id, ['delivery_challan']);
        qty = r2(limit - consumedQty(l.id, consumers));
      }
      if (toType === 'purchase_order' && src.type === 'rfq') {
        const award = d.get<Row>('SELECT * FROM rfq_bids WHERE line_id = ? AND awarded = 1 AND (? IS NULL OR vendor_id = ?)', l.id, opts.vendor_id ?? null, opts.vendor_id ?? null);
        if (!award) return null;
        return { item_id: l.item_id, description: l.description, qty: l.qty, rate: award.rate, ref_line_id: l.id, _vendor: award.vendor_id } as any;
      }
      const tracking = json<any[]>(l.tracking, []);
      return {
        item_id: l.item_id, account_id: l.account_id, description: l.description, hsn_code: l.hsn_code, unit: l.unit, qty,
        rate: l.rate, discount_pct: l.discount_pct, tax_id: l.tax_id, tax_exempt: l.tax_exempt, warehouse_id: l.warehouse_id,
        ref_line_id: consumers || ['purchase_request', 'rfq', 'quote'].includes(src.type) ? l.id : null,
        itc_eligible: !!l.itc_eligible,
        tracking: ['credit_note', 'sales_return', 'vendor_credit', 'package', 'delivery_challan'].includes(toType) && tracking.length && qty === l.qty ? tracking : [],
      } as LineInput;
    }).filter((l): l is LineInput => !!l && (l.qty ?? 0) > 0);
  }
  if (['package', 'delivery_challan', 'purchase_receive', 'sales_return'].includes(toType)) {
    lines = lines.filter((l) => l.item_id && d.value<string>('SELECT type FROM items WHERE id = ?', l.item_id) === 'goods');
  }
  if (!lines.length) fail(`Nothing left to convert from ${src.number}`, 422);
  let contact_id = sameParty ? src.contact_id : opts.contact_id ?? null;
  if (toType === 'purchase_order' && src.type === 'rfq') {
    const vendors = [...new Set(lines.map((l: any) => l._vendor))];
    contact_id = opts.vendor_id ?? vendors[0];
    lines = lines.filter((l: any) => l._vendor === contact_id).map(({ _vendor, ...l }: any) => l);
  }
  if (toType === 'purchase_order' && src.type === 'sales_order') {
    lines = lines.map((l) => {
      const item = l.item_id ? d.get<Row>('SELECT purchase_rate, preferred_vendor_id FROM items WHERE id = ?', l.item_id) : null;
      return { ...l, rate: item?.purchase_rate ?? 0, ref_line_id: null };
    });
    contact_id = opts.vendor_id ?? null;
    refDocId = src.id;
  }
  if (DOC_TYPES[toType].priced && !DOC_TYPES[src.type].priced) {
    // Unpriced sources (sales returns, receives) take price and GST from the priced line they came from.
    lines = lines.map((l) => {
      const anc = pricedAncestor(l.ref_line_id ?? null);
      return anc ? { ...l, rate: anc.rate, discount_pct: anc.discount_pct, tax_id: anc.tax_id, tax_exempt: anc.tax_exempt, account_id: anc.account_id ?? l.account_id } : l;
    });
  }
  const keepPrices = ['quote', 'sales_order', 'invoice', 'purchase_order', 'bill', 'delivery_challan', 'credit_note', 'vendor_credit'].includes(toType);
  return {
    type: toType,
    date: today(),
    contact_id,
    warehouse_id: src.warehouse_id,
    currency_code: src.currency_code,
    exchange_rate: src.exchange_rate,
    place_of_supply: sameParty ? src.place_of_supply : undefined,
    reference: src.number,
    salesperson: src.salesperson,
    ref_doc_id: refDocId,
    reverse_charge: !!src.reverse_charge,
    tax_inclusive: !!src.tax_inclusive,
    notes: src.notes,
    terms: src.terms,
    data: toType === 'invoice' && srcData.shipping_address ? { shipping_address: srcData.shipping_address } : {},
    lines: keepPrices ? lines : lines.map((l) => ({ ...l, rate: toType === 'purchase_receive' || toType === 'package' ? 0 : l.rate })),
  };
}

function pricedAncestor(lineId: number | null): Row | null {
  let id = lineId;
  for (let i = 0; id && i < 4; i++) {
    const l = db().get<Row>('SELECT l.*, d.type FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE l.id = ?', id);
    if (!l) return null;
    if (DOC_TYPES[l.type]?.priced) return l;
    id = l.ref_line_id;
  }
  return null;
}

export function createFrom(fromId: number, toType: string, user: AuthUser | undefined, overrides: Row = {}, submit = true) {
  const draft = convertDraft(fromId, toType, overrides);
  const { type, ...input } = draft;
  return createDocument(type, { ...input, ...overrides, lines: overrides.lines ?? input.lines }, user, { submit });
}

export function emailDocument(id: number, to: string | undefined, user?: AuthUser) {
  const doc = db().get<Row>('SELECT d.*, c.email AS contact_email, c.name AS contact_name FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.id = ?', id) ?? fail('Document not found', 404);
  const addr = to || doc.contact_email;
  if (!addr) fail('The contact has no email address', 422);
  const def = docType(doc.type);
  const o = org();
  queueEmail(addr, `${def.label} ${doc.number} from ${o.name}`,
    `Dear ${doc.contact_name ?? 'Sir/Madam'},\n\nPlease find ${def.label.toLowerCase()} ${doc.number} for ₹${doc.total.toFixed(2)} attached.\n\nRegards,\n${o.name}`, doc.type, id);
  audit(doc.type, id, 'emailed', `${def.label} ${doc.number} emailed to ${addr}`, user);
  if (doc.status === 'draft' && ['quote', 'invoice'].includes(doc.type)) submitDocument(id, user);
}

export function assertDocPerm(user: AuthUser | undefined, type: string, action: 'view' | 'create' | 'edit' | 'delete' | 'approve') {
  assertCan(user, docType(type).module, action);
}

export { buildMoves, isPosted, adminUsers };
export type { FullDoc };
