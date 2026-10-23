import { audit, queueEmail } from '../activity.js';
import { assertCan, type AuthUser } from '../auth.js';
import { db, fail, json, type Row } from '../db.js';
import { cancelEwb, cancelIrn, recordEwb, recordIrn, updateEwbVehicle } from '../einvoice.js';
import { applyCredits } from '../payments.js';
import { org } from '../settings.js';
import { isDate, r2, today } from '../util.js';
import {
  approveDocument, createDocument, createFrom, emailDocument, getDocument, refreshParent, rejectDocument, setStatus, submitDocument, voidDocument,
} from './engine.js';
import { docType } from './types.js';

type Handler = (doc: Row, body: Row, user?: AuthUser) => unknown;
interface ActionDef {
  label: string;
  types: string[] | '*';
  when: (doc: Row) => boolean;
  perm?: 'create' | 'edit' | 'delete' | 'approve';
  run: Handler;
}

const st = (...s: string[]) => (doc: Row) => s.includes(doc.status);
const data = (doc: Row) => json<Row>(doc.data, {});

// ---------- RFQ bidding ----------

function recordBid(doc: Row, body: Row, user?: AuthUser) {
  if (doc.status !== 'open') fail('Bids can only be recorded while the RFQ is open', 422);
  const vendorIds: number[] = data(doc).vendor_ids ?? [];
  const vendorId = Number(body.vendor_id);
  if (!vendorIds.includes(vendorId)) fail('This vendor was not invited to the RFQ', 422);
  const due = doc.due_date;
  if (due && today() > due && !body.allow_late) fail(`Bidding closed on ${due}`, 422);
  const lines = db().all<{ id: number }>('SELECT id FROM document_lines WHERE document_id = ?', doc.id).map((l) => l.id);
  const bids: Row[] = body.bids ?? [];
  if (!bids.length) fail('Enter at least one bid', 422);
  for (const b of bids) {
    if (!lines.includes(Number(b.line_id))) fail('Bid line does not belong to this RFQ', 422);
    const rate = Number(b.rate);
    if (!(rate > 0)) fail('Bid rate must be greater than zero', 422);
    db().run(
      `INSERT INTO rfq_bids (rfq_id, vendor_id, line_id, rate, lead_days, notes, surrogate) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(rfq_id, vendor_id, line_id) DO UPDATE SET rate = excluded.rate, lead_days = excluded.lead_days, notes = excluded.notes, submitted_at = CURRENT_TIMESTAMP`,
      doc.id, vendorId, Number(b.line_id), rate, b.lead_days ?? null, b.notes ?? null, body.surrogate === false ? 0 : 1);
  }
  audit('rfq', doc.id, 'bid', `Bid recorded for vendor #${vendorId}`, user);
}

function awardRfq(doc: Row, body: Row, user?: AuthUser) {
  if (!['open', 'closed', 'awarded'].includes(doc.status)) fail('RFQ is not open for awarding', 422);
  const awards: Row[] = body.awards ?? [];
  if (!awards.length) fail('Choose a vendor for at least one line', 422);
  db().run('UPDATE rfq_bids SET awarded = 0 WHERE rfq_id = ?', doc.id);
  for (const a of awards) {
    const bid = db().get<Row>('SELECT id FROM rfq_bids WHERE rfq_id = ? AND line_id = ? AND vendor_id = ?', doc.id, a.line_id, a.vendor_id);
    if (!bid) fail('You can only award a line to a vendor who bid on it', 422);
    db().run('UPDATE rfq_bids SET awarded = 1 WHERE id = ?', bid!.id);
  }
  setStatus(doc.id, 'awarded', user, undefined, 'awarded');
}

function lowestBidAwards(rfqId: number) {
  return db().all<Row>(
    `SELECT line_id, vendor_id FROM rfq_bids b WHERE rfq_id = ? AND rate = (SELECT MIN(rate) FROM rfq_bids WHERE rfq_id = b.rfq_id AND line_id = b.line_id) GROUP BY line_id`, rfqId);
}

function createPosFromRfq(doc: Row, _body: Row, user?: AuthUser) {
  if (doc.status !== 'awarded') fail('Award the RFQ before creating purchase orders', 422);
  const vendors = db().all<{ vendor_id: number }>('SELECT DISTINCT vendor_id FROM rfq_bids WHERE rfq_id = ? AND awarded = 1', doc.id);
  const ids: number[] = [];
  for (const v of vendors) ids.push(createFrom(doc.id, 'purchase_order', user, { vendor_id: v.vendor_id, contact_id: v.vendor_id }, false));
  return { created: ids };
}

// ---------- Stock counts ----------

function startCount(doc: Row, _b: Row, user?: AuthUser) {
  const lines = db().all<Row>('SELECT * FROM document_lines WHERE document_id = ?', doc.id);
  for (const l of lines) {
    const expected = db().value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = ? AND warehouse_id = ? AND physical = 1', l.item_id, l.warehouse_id || doc.warehouse_id) ?? 0;
    db().update('document_lines', l.id, { qty: r2(expected) });
  }
  setStatus(doc.id, 'in_progress', user, { started_at: new Date().toISOString() }, 'started');
}

function completeCount(doc: Row, body: Row, user?: AuthUser) {
  const counted: Row[] = body.counts ?? [];
  for (const c of counted) db().run('UPDATE document_lines SET qty2 = ? WHERE id = ? AND document_id = ?', Number(c.counted), c.line_id, doc.id);
  const lines = db().all<Row>('SELECT * FROM document_lines WHERE document_id = ?', doc.id);
  if (lines.some((l) => l.qty2 == null)) fail('Enter the counted quantity for every line', 422);
  const diffs = lines.filter((l) => Math.abs(l.qty2 - l.qty) > 1e-9);
  let adjustmentId: number | null = null;
  if (diffs.length) {
    adjustmentId = createDocument('inventory_adjustment', {
      date: body.date ?? today(), warehouse_id: doc.warehouse_id, ref_doc_id: doc.id, reference: doc.number,
      data: { mode: 'quantity', reason: 'Stock count variance' },
      lines: diffs.map((l) => ({ item_id: l.item_id, qty: r2(l.qty2 - l.qty), ref_line_id: l.id, warehouse_id: l.warehouse_id, tracking: json(body.tracking?.[l.id], []) })),
    }, user, { submit: true });
  }
  setStatus(doc.id, 'completed', user, { completed_at: new Date().toISOString(), adjustment_id: adjustmentId }, 'completed');
  return { adjustment_id: adjustmentId };
}

// ---------- Registry ----------

export const ACTIONS: Record<string, ActionDef> = {
  submit: { label: 'Submit', types: '*', when: st('draft', 'rejected'), perm: 'edit', run: (doc, _b, u) => submitDocument(doc.id, u) },
  approve: { label: 'Approve', types: '*', when: st('pending_approval'), perm: 'approve', run: (doc, b, u) => approveDocument(doc.id, u, b.comment) },
  reject: { label: 'Reject', types: '*', when: st('pending_approval'), perm: 'approve', run: (doc, b, u) => rejectDocument(doc.id, u, b.comment) },
  void: {
    label: 'Void', types: ['sales_order', 'invoice', 'credit_note', 'bill', 'vendor_credit', 'expense', 'retainer_invoice', 'sales_return'],
    when: (doc) => doc.status !== 'void' && doc.status !== 'draft', perm: 'delete', run: (doc, b, u) => voidDocument(doc.id, u, b.reason),
  },
  email: { label: 'Send Email', types: ['quote', 'sales_order', 'invoice', 'credit_note', 'purchase_order', 'retainer_invoice', 'delivery_challan', 'rfq'], when: (doc) => doc.status !== 'void', perm: 'edit', run: (doc, b, u) => emailDocument(doc.id, b.to, u) },
  comment: {
    label: 'Comment', types: '*', when: () => true, perm: undefined,
    run: (doc, b, u) => {
      if (!String(b.body ?? '').trim()) fail('Comment cannot be empty', 422);
      db().insert('comments', { entity: doc.type, entity_id: doc.id, user_id: u?.id ?? null, body: String(b.body).trim() });
    },
  },
  mark_accepted: { label: 'Mark as Accepted', types: ['quote'], when: st('sent', 'declined'), perm: 'edit', run: (doc, _b, u) => setStatus(doc.id, 'accepted', u) },
  mark_declined: { label: 'Mark as Declined', types: ['quote'], when: st('sent', 'accepted'), perm: 'edit', run: (doc, _b, u) => setStatus(doc.id, 'declined', u) },
  close: {
    label: 'Close', types: ['sales_order', 'purchase_order', 'purchase_request'], when: st('confirmed', 'issued', 'approved'), perm: 'edit',
    run: (doc, _b, u) => setStatus(doc.id, 'closed', u, { manually_closed: true }, 'closed'),
  },
  reopen: {
    label: 'Reopen', types: ['sales_order', 'purchase_order'], when: st('closed'), perm: 'edit',
    run: (doc, _b, u) => setStatus(doc.id, doc.type === 'sales_order' ? 'confirmed' : 'issued', u, { manually_closed: false }, 'reopened'),
  },
  cancel: {
    label: 'Cancel', types: ['purchase_order', 'rfq', 'stock_count'], when: st('draft', 'issued', 'open', 'closed', 'in_progress'), perm: 'edit',
    run: (doc, _b, u) => {
      if (db().value<number>("SELECT COUNT(*) FROM documents WHERE ref_doc_id = ? AND status <> 'void'", doc.id)) fail('This document has linked transactions and cannot be cancelled', 422);
      setStatus(doc.id, 'cancelled', u, undefined, 'cancelled');
    },
  },
  ship: {
    label: 'Mark as Shipped', types: ['package'], when: st('packed'), perm: 'edit',
    run: (doc, b, u) => {
      const date = b.date ?? today();
      if (!isDate(date) || date < doc.date) fail('Shipment date must be on or after the package date', 422);
      setStatus(doc.id, 'shipped', u, { shipment: { date, carrier: b.carrier ?? null, tracking_no: b.tracking_no ?? null, charges: Number(b.charges ?? 0) } }, 'shipped');
    },
  },
  deliver: {
    label: 'Mark as Delivered', types: ['package'], when: st('shipped'), perm: 'edit',
    run: (doc, b, u) => setStatus(doc.id, 'delivered', u, { delivered_on: b.date ?? today() }, 'delivered'),
  },
  unship: { label: 'Undo Shipment', types: ['package'], when: st('shipped', 'delivered'), perm: 'edit', run: (doc, _b, u) => setStatus(doc.id, 'packed', u, { shipment: null, delivered_on: null }, 'unshipped') },
  receive_return: {
    label: 'Receive Items', types: ['sales_return'], when: st('approved'), perm: 'edit',
    run: (doc, b, u) => {
      if (b.warehouse_id) db().update('documents', doc.id, { warehouse_id: Number(b.warehouse_id) });
      setStatus(doc.id, 'received', u, { received_date: b.date ?? today() }, 'received');
      refreshParent(doc.id);
    },
  },
  mark_delivered: { label: 'Mark as Delivered', types: ['delivery_challan'], when: st('open'), perm: 'edit', run: (doc, _b, u) => setStatus(doc.id, 'delivered', u) },
  mark_returned: {
    label: 'Mark as Returned', types: ['delivery_challan'], when: st('open', 'delivered'), perm: 'edit',
    run: (doc, _b, u) => {
      if (db().value<number>("SELECT COUNT(*) FROM documents WHERE ref_doc_id = ? AND status <> 'void'", doc.id)) fail('An invoice exists for this challan', 422);
      setStatus(doc.id, 'returned', u, { returned_on: today() }, 'returned');
    },
  },
  mark_transferred: {
    label: 'Mark as Transferred', types: ['transfer_order'], when: st('in_transit'), perm: 'edit',
    run: (doc, b, u) => {
      const date = b.date ?? today();
      if (date < doc.date) fail('Receipt date cannot be before the transfer date', 422);
      setStatus(doc.id, 'transferred', u, { transferred_date: date }, 'transferred');
    },
  },
  einvoice_record: {
    label: 'Record IRN', types: ['invoice', 'credit_note'],
    when: (doc) => ['open', 'partially_paid', 'paid', 'closed'].includes(doc.status) && data(doc).einvoice?.status !== 'generated', perm: 'edit',
    run: (doc, b, u) => recordIrn(doc, b, u),
  },
  einvoice_cancel: { label: 'Mark IRN Cancelled', types: ['invoice', 'credit_note'], when: (doc) => data(doc).einvoice?.status === 'generated', perm: 'edit', run: (doc, b, u) => cancelIrn(doc, b, u) },
  eway_record: {
    label: 'Record e-Way Bill', types: ['invoice', 'delivery_challan', 'credit_note'],
    when: (doc) => !['draft', 'void', 'returned', 'pending_approval', 'rejected'].includes(doc.status) && data(doc).ewaybill?.status !== 'generated', perm: 'edit',
    run: (doc, b, u) => recordEwb(doc, b, u),
  },
  eway_update_vehicle: { label: 'Update Vehicle (Part-B)', types: ['invoice', 'delivery_challan', 'credit_note'], when: (doc) => data(doc).ewaybill?.status === 'generated', perm: 'edit', run: (doc, b, u) => updateEwbVehicle(doc, b, u) },
  eway_cancel: { label: 'Mark e-Way Bill Cancelled', types: ['invoice', 'delivery_challan', 'credit_note'], when: (doc) => data(doc).ewaybill?.status === 'generated', perm: 'edit', run: (doc, b, u) => cancelEwb(doc, b, u) },
  apply_credits: {
    label: 'Apply to Invoices', types: ['credit_note', 'vendor_credit', 'retainer_invoice'],
    when: (doc) => (doc.type === 'retainer_invoice' ? ['paid', 'open'].includes(doc.status) : doc.status === 'open'), perm: 'edit',
    run: (doc, b, u) => applyCredits({ credit_doc_id: doc.id }, b.allocations ?? [], u, b.date),
  },
  publish: {
    label: 'Send to Vendors', types: ['rfq'], when: st('draft'), perm: 'edit',
    run: (doc, _b, u) => {
      const vendorIds: number[] = data(doc).vendor_ids ?? [];
      if (!vendorIds.length) fail('Invite at least one vendor', 422);
      for (const v of db().all<Row>(`SELECT name, email FROM contacts WHERE id IN (${vendorIds.map(() => '?').join(',')})`, ...vendorIds)) {
        if (v.email) queueEmail(v.email, `Request for quotation ${doc.number}`, `Dear ${v.name},\n\nPlease submit your best quote for ${doc.number} by ${doc.due_date ?? 'the deadline'}.\n\n${org().name}`, 'rfq', doc.id);
      }
      setStatus(doc.id, 'open', u, { published_at: new Date().toISOString() }, 'published');
    },
  },
  record_bid: { label: 'Record Bid', types: ['rfq'], when: st('open'), perm: 'edit', run: (doc, b, u) => recordBid(doc, b, u) },
  close_bidding: { label: 'Close Bidding', types: ['rfq'], when: st('open'), perm: 'edit', run: (doc, _b, u) => setStatus(doc.id, 'closed', u, undefined, 'closed') },
  award: {
    label: 'Award', types: ['rfq'], when: st('open', 'closed', 'awarded'), perm: 'approve',
    run: (doc, b, u) => awardRfq(doc, { awards: b.awards ?? (b.lowest ? lowestBidAwards(doc.id) : []) }, u),
  },
  create_pos: { label: 'Create Purchase Orders', types: ['rfq'], when: st('awarded'), perm: 'create', run: createPosFromRfq },
  start_count: { label: 'Start Counting', types: ['stock_count'], when: st('draft'), perm: 'edit', run: startCount },
  complete_count: { label: 'Complete Count', types: ['stock_count'], when: st('in_progress'), perm: 'edit', run: completeCount },
};

export function availableActions(doc: Row): { key: string; label: string }[] {
  return Object.entries(ACTIONS)
    .filter(([, a]) => (a.types === '*' || a.types.includes(doc.type)) && a.when(doc))
    .filter(([k]) => !(k === 'submit' && ['package', 'sales_return', 'purchase_receive'].includes(doc.type)))
    .filter(([k]) => !((k === 'approve' || k === 'reject') && !docType(doc.type).approvable))
    .map(([key, a]) => ({ key, label: a.label }));
}

export function runAction(id: number, action: string, body: Row, user?: AuthUser) {
  const doc = db().get<Row>('SELECT * FROM documents WHERE id = ?', id) ?? fail('Document not found', 404);
  const a = ACTIONS[action] ?? fail(`Unknown action '${action}'`, 404);
  if (!(a.types === '*' || a.types.includes(doc.type))) fail(`'${a.label}' is not available for this document`, 422);
  if (!a.when(doc)) fail(`'${a.label}' is not available in the current status (${doc.status})`, 422);
  if (a.perm) assertCan(user, docType(doc.type).module, a.perm);
  const result = db().tx(() => a.run(doc, body ?? {}, user));
  return { result: result ?? null, document: getDocument(id, user) };
}
