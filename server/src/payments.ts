import { audit, runWorkflows } from './activity.js';
import type { AuthUser } from './auth.js';
import { db, fail, type Row } from './db.js';
import { creditUsed, refreshBalance } from './documents/engine.js';
import { acct, journalsFor, replaceJournal, type JLine } from './ledger.js';
import { assertUnlocked, nextNumber } from './settings.js';
import { isDate, r2, today } from './util.js';

export interface PaymentInput {
  kind: 'received' | 'made';
  date?: string;
  contact_id: number;
  amount: number;
  bank_charges?: number;
  tds_amount?: number;
  mode?: string;
  account_id: number;
  reference?: string;
  notes?: string;
  currency_code?: string;
  exchange_rate?: number;
  allocations?: { document_id: number; amount: number }[];
}

const MODES = ['cash', 'bank_transfer', 'cheque', 'upi', 'card', 'neft', 'rtgs', 'imps', 'other'];
const PAYABLE_DOCS = { received: ['invoice', 'retainer_invoice'], made: ['bill'] };
const lockOf = (kind: string) => (kind === 'received' ? 'sales' : 'purchases') as 'sales' | 'purchases';

export function paymentUnused(id: number): number {
  const d = db();
  const p = d.get<Row>('SELECT * FROM payments WHERE id = ?', id);
  if (!p || p.status === 'void') return 0;
  const alloc = d.value<number>('SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE payment_id = ?', id) ?? 0;
  const applied = d.value<number>('SELECT COALESCE(SUM(amount),0) FROM credit_applications WHERE payment_id = ?', id) ?? 0;
  const refunded = d.value<number>('SELECT COALESCE(SUM(amount),0) FROM refunds WHERE payment_id = ?', id) ?? 0;
  return r2(p.amount + p.tds_amount - alloc - applied - refunded);
}

function validate(input: PaymentInput, existingId?: number) {
  const d = db();
  if (!['received', 'made'].includes(input.kind)) fail('Invalid payment kind', 422);
  const date = input.date ?? today();
  if (!isDate(date)) fail('Payment date is invalid', 422);
  const contact = d.get<Row>('SELECT * FROM contacts WHERE id = ?', input.contact_id) ?? fail('Contact not found', 422);
  if (contact.kind !== (input.kind === 'received' ? 'customer' : 'vendor')) fail(`Contact must be a ${input.kind === 'received' ? 'customer' : 'vendor'}`, 422);
  const amount = r2(Number(input.amount));
  if (!(amount > 0)) fail('Amount must be greater than zero', 422);
  const bank_charges = r2(Number(input.bank_charges ?? 0));
  const tds_amount = r2(Number(input.tds_amount ?? 0));
  if (bank_charges < 0 || tds_amount < 0) fail('Charges and TDS cannot be negative', 422);
  if (input.kind === 'received' && bank_charges >= amount) fail('Bank charges must be less than the amount', 422);
  const account = d.get<Row>('SELECT * FROM accounts WHERE id = ?', input.account_id) ?? fail('Deposit account not found', 422);
  if (!['cash', 'bank', 'credit_card', 'other_current_asset'].includes(account.type)) fail('Choose a cash, bank or card account', 422);
  const mode = input.mode ?? 'bank_transfer';
  if (!MODES.includes(mode)) fail('Invalid payment mode', 422);
  const allocations = (input.allocations ?? []).filter((a) => Number(a.amount) > 0).map((a) => ({ document_id: Number(a.document_id), amount: r2(Number(a.amount)) }));
  const seen = new Set<number>();
  let allocated = 0;
  for (const a of allocations) {
    if (seen.has(a.document_id)) fail('A document appears twice in the allocation', 422);
    seen.add(a.document_id);
    const doc = d.get<Row>('SELECT * FROM documents WHERE id = ?', a.document_id) ?? fail('Document not found', 422);
    if (!PAYABLE_DOCS[input.kind].includes(doc.type)) fail(`${doc.number} cannot be paid with this payment`, 422);
    if (doc.contact_id !== contact.id) fail(`${doc.number} belongs to another contact`, 422);
    if (!['open', 'partially_paid', 'paid'].includes(doc.status)) fail(`${doc.number} is not open for payment`, 422);
    const mine = existingId ? d.value<number>('SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE payment_id = ? AND document_id = ?', existingId, a.document_id) ?? 0 : 0;
    if (a.amount > r2(doc.balance + mine) + 0.001) fail(`Payment of ${a.amount} exceeds the balance ${r2(doc.balance + mine)} of ${doc.number}`, 422);
    allocated += a.amount;
  }
  if (r2(allocated) > r2(amount + tds_amount) + 0.001) fail('Allocated amount exceeds the payment amount', 422);
  const currency_code = input.currency_code ?? contact.currency_code ?? 'INR';
  const exchange_rate = currency_code === 'INR' ? 1 : Number(input.exchange_rate ?? d.value<number>('SELECT rate FROM currencies WHERE code = ?', currency_code) ?? 1);
  return {
    row: { kind: input.kind, date, contact_id: contact.id, amount, bank_charges, tds_amount, mode, account_id: account.id, reference: input.reference ?? null, notes: input.notes ?? null, currency_code, exchange_rate },
    allocations,
  };
}

export function postPaymentJournal(id: number) {
  const d = db();
  const p = d.get<Row>('SELECT * FROM payments WHERE id = ?', id);
  if (!p) return;
  if (p.status === 'void') return replaceJournal('payment', id, null);
  const ex = p.exchange_rate || 1;
  const b = (x: number) => r2(x * ex);
  const lines: JLine[] = [];
  const c = p.contact_id;
  const allocs = d.all<Row>('SELECT a.amount, doc.exchange_rate FROM payment_allocations a JOIN documents doc ON doc.id = a.document_id WHERE a.payment_id = ?', id);
  const allocFc = allocs.reduce((a, x) => a + x.amount, 0);
  const partyBase = r2(allocs.reduce((a, x) => a + r2(x.amount * (x.exchange_rate || 1)), 0) + b(p.amount + p.tds_amount - allocFc));
  if (p.kind === 'received') {
    lines.push({ account_id: p.account_id, debit: b(p.amount - p.bank_charges), contact_id: c });
    if (p.bank_charges) lines.push({ account_id: acct('bank_charges'), debit: b(p.bank_charges), contact_id: c });
    if (p.tds_amount) lines.push({ account_id: acct('tds_receivable'), debit: b(p.tds_amount), contact_id: c });
    lines.push({ account_id: acct('accounts_receivable'), credit: partyBase, contact_id: c });
  } else {
    lines.push({ account_id: p.account_id, credit: b(p.amount + p.bank_charges), contact_id: c });
    if (p.bank_charges) lines.push({ account_id: acct('bank_charges'), debit: b(p.bank_charges), contact_id: c });
    lines.push({ account_id: acct('accounts_payable'), debit: partyBase, contact_id: c });
  }
  const diff = r2(lines.reduce((a, l) => a + (l.debit ?? 0) - (l.credit ?? 0), 0));
  if (diff) lines.push({ account_id: acct('exchange_gain_loss'), debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, description: 'Realised exchange gain/loss' });
  replaceJournal('payment', id, { date: p.date, memo: `Payment ${p.kind} ${p.number}`, reference: p.reference, lines });
}

function writeAllocations(paymentId: number, allocations: { document_id: number; amount: number }[]) {
  const d = db();
  const before = d.all<{ document_id: number }>('SELECT document_id FROM payment_allocations WHERE payment_id = ?', paymentId).map((r) => r.document_id);
  d.run('DELETE FROM payment_allocations WHERE payment_id = ?', paymentId);
  for (const a of allocations) d.insert('payment_allocations', { payment_id: paymentId, ...a });
  for (const docId of new Set([...before, ...allocations.map((a) => a.document_id)])) refreshBalance(docId);
}

export function createPayment(input: PaymentInput, user?: AuthUser) {
  return db().tx(() => {
    const { row, allocations } = validate(input);
    assertUnlocked(lockOf(row.kind), row.date, 'payment');
    const number = nextNumber(row.kind === 'received' ? 'payment_received' : 'payment_made');
    const id = db().insert('payments', { ...row, number, created_by: user?.id ?? null });
    writeAllocations(id, allocations);
    postPaymentJournal(id);
    audit('payment', id, 'created', `Payment ${row.kind} ${number} of ₹${row.amount}`, user);
    runWorkflows(`payment_${row.kind}`, 'on_create', { ...row, id, number }, user, 'payments');
    return id;
  });
}

export function updatePayment(id: number, input: PaymentInput, user?: AuthUser) {
  return db().tx(() => {
    const existing = db().get<Row>('SELECT * FROM payments WHERE id = ?', id) ?? fail('Payment not found', 404);
    if (existing.status === 'void') fail('Void payments cannot be edited', 422);
    if (db().get('SELECT 1 FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE j.source_type = ? AND j.source_id = ? AND jl.recon_id IS NOT NULL', 'payment', id)) {
      fail('This payment is reconciled. Undo the reconciliation before editing.', 422);
    }
    assertUnlocked(lockOf(existing.kind), existing.date, 'payment');
    const { row, allocations } = validate({ ...input, kind: existing.kind }, id);
    assertUnlocked(lockOf(existing.kind), row.date, 'payment');
    const applied = db().value<number>('SELECT COALESCE(SUM(amount),0) FROM credit_applications WHERE payment_id = ?', id) ?? 0;
    const refunded = db().value<number>('SELECT COALESCE(SUM(amount),0) FROM refunds WHERE payment_id = ?', id) ?? 0;
    if (r2(allocations.reduce((a, x) => a + x.amount, 0) + applied + refunded) > r2(row.amount + row.tds_amount) + 0.001) {
      fail('Amount is less than what has already been applied or refunded', 422);
    }
    db().update('payments', id, row);
    writeAllocations(id, allocations);
    postPaymentJournal(id);
    audit('payment', id, 'updated', `Payment ${existing.number} updated`, user);
    return id;
  });
}

export function deletePayment(id: number, user?: AuthUser) {
  db().tx(() => {
    const p = db().get<Row>('SELECT * FROM payments WHERE id = ?', id) ?? fail('Payment not found', 404);
    assertUnlocked(lockOf(p.kind), p.date, 'payment');
    if (db().get('SELECT 1 FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE j.source_type = ? AND j.source_id = ? AND jl.recon_id IS NOT NULL', 'payment', id)) {
      fail('This payment is reconciled. Undo the reconciliation before deleting.', 422);
    }
    const docs = db().all<{ document_id: number }>('SELECT document_id FROM payment_allocations WHERE payment_id = ? UNION SELECT document_id FROM credit_applications WHERE payment_id = ?', id, id);
    for (const r of db().all<{ id: number }>('SELECT id FROM refunds WHERE payment_id = ?', id)) replaceJournal('refund', r.id, null);
    db().run('DELETE FROM refunds WHERE payment_id = ?', id);
    replaceJournal('payment', id, null);
    db().run("UPDATE bank_statement_lines SET status = 'uncategorized', matched_source_type = NULL, matched_source_id = NULL WHERE matched_source_type = 'payment' AND matched_source_id = ?", id);
    db().run('DELETE FROM payments WHERE id = ?', id);
    for (const d of docs) refreshBalance(d.document_id);
    audit('payment', id, 'deleted', `Payment ${p.number} deleted`, user);
  });
}

export function getPayment(id: number) {
  const d = db();
  const p = d.get<Row>(`SELECT p.*, c.name AS contact_name, a.name AS account_name FROM payments p JOIN contacts c ON c.id = p.contact_id
    JOIN accounts a ON a.id = p.account_id WHERE p.id = ?`, id) ?? fail('Payment not found', 404);
  return {
    ...p,
    allocations: d.all<Row>(`SELECT a.*, doc.number, doc.type, doc.date, doc.total, doc.balance FROM payment_allocations a JOIN documents doc ON doc.id = a.document_id WHERE a.payment_id = ?`, id),
    applications: d.all<Row>(`SELECT ca.*, doc.number, doc.type FROM credit_applications ca JOIN documents doc ON doc.id = ca.document_id WHERE ca.payment_id = ?`, id),
    refunds: d.all<Row>('SELECT r.*, a.name AS account_name FROM refunds r JOIN accounts a ON a.id = r.account_id WHERE r.payment_id = ?', id),
    unused: paymentUnused(id),
    journal: journalsFor('payment', id),
  };
}

export function listPayments(kind: string, q: Row) {
  const where = ['p.kind = ?'];
  const params: unknown[] = [kind];
  if (q.contact_id) { where.push('p.contact_id = ?'); params.push(q.contact_id); }
  if (q.from) { where.push('p.date >= ?'); params.push(q.from); }
  if (q.to) { where.push('p.date <= ?'); params.push(q.to); }
  if (q.search) { where.push('(p.number LIKE ? OR p.reference LIKE ? OR c.name LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`); }
  const rows = db().all<Row>(
    `SELECT p.*, c.name AS contact_name, a.name AS account_name FROM payments p JOIN contacts c ON c.id = p.contact_id JOIN accounts a ON a.id = p.account_id
     WHERE ${where.join(' AND ')} ORDER BY p.date DESC, p.id DESC LIMIT 500`, ...params);
  return { rows: rows.map((r) => ({ ...r, unused: paymentUnused(r.id) })), total: rows.length };
}

/** Applies credit notes, vendor credits, retainer advances or excess payments against open invoices/bills. */
export function applyCredits(source: { credit_doc_id?: number; payment_id?: number }, allocations: { document_id: number; amount: number }[], user?: AuthUser, date?: string) {
  return db().tx(() => {
    const d = db();
    let available = 0;
    let contactId: number;
    let targetTypes: string[];
    if (source.credit_doc_id) {
      const cd = d.get<Row>('SELECT * FROM documents WHERE id = ?', source.credit_doc_id) ?? fail('Credit not found', 404);
      if (!['credit_note', 'vendor_credit', 'retainer_invoice'].includes(cd.type)) fail('This document cannot be applied as a credit', 422);
      if (cd.type === 'retainer_invoice') available = r2(cd.total - cd.balance - creditUsed(cd.id));
      else {
        if (!['open'].includes(cd.status)) fail('Only open credits can be applied', 422);
        available = cd.balance;
      }
      contactId = cd.contact_id;
      targetTypes = cd.type === 'vendor_credit' ? ['bill'] : ['invoice'];
    } else if (source.payment_id) {
      const p = d.get<Row>('SELECT * FROM payments WHERE id = ?', source.payment_id) ?? fail('Payment not found', 404);
      available = paymentUnused(p.id);
      contactId = p.contact_id;
      targetTypes = p.kind === 'received' ? ['invoice'] : ['bill'];
    } else return fail('Specify a credit or payment', 422);
    let total = 0;
    for (const a of allocations) {
      const amt = r2(Number(a.amount));
      if (!(amt > 0)) continue;
      const doc = d.get<Row>('SELECT * FROM documents WHERE id = ?', a.document_id) ?? fail('Document not found', 404);
      if (!targetTypes.includes(doc.type) || doc.contact_id !== contactId) fail(`Credits cannot be applied to ${doc.number}`, 422);
      if (!['open', 'partially_paid'].includes(doc.status)) fail(`${doc.number} is not open`, 422);
      if (amt > doc.balance + 0.001) fail(`Amount exceeds the balance of ${doc.number}`, 422);
      total += amt;
      if (total > available + 0.001) fail(`Only ${available} credit is available`, 422);
      d.insert('credit_applications', { credit_doc_id: source.credit_doc_id ?? null, payment_id: source.payment_id ?? null, document_id: doc.id, amount: amt, date: date ?? today() });
      refreshBalance(doc.id);
    }
    if (source.credit_doc_id) refreshBalance(source.credit_doc_id);
    audit(source.credit_doc_id ? 'credit' : 'payment', source.credit_doc_id ?? source.payment_id!, 'applied', `Applied ₹${r2(total)} of credits`, user);
    return r2(total);
  });
}

export function removeCreditApplication(id: number, user?: AuthUser) {
  db().tx(() => {
    const ca = db().get<Row>('SELECT * FROM credit_applications WHERE id = ?', id) ?? fail('Not found', 404);
    db().run('DELETE FROM credit_applications WHERE id = ?', id);
    refreshBalance(ca.document_id);
    if (ca.credit_doc_id) refreshBalance(ca.credit_doc_id);
    audit('credit', ca.credit_doc_id ?? ca.payment_id, 'unapplied', `Removed credit application of ₹${ca.amount}`, user);
  });
}

export function createRefund(input: { credit_doc_id?: number; payment_id?: number; date?: string; amount: number; account_id: number; mode?: string; reference?: string }, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const date = input.date ?? today();
    const amount = r2(Number(input.amount));
    if (!(amount > 0)) fail('Refund amount must be positive', 422);
    let kind: 'customer' | 'vendor';
    let contactId: number;
    let available: number;
    if (input.credit_doc_id) {
      const cd = d.get<Row>('SELECT * FROM documents WHERE id = ?', input.credit_doc_id) ?? fail('Credit not found', 404);
      if (!['credit_note', 'vendor_credit'].includes(cd.type) || cd.status !== 'open') fail('Only open credit notes or vendor credits can be refunded', 422);
      kind = cd.type === 'credit_note' ? 'customer' : 'vendor';
      contactId = cd.contact_id;
      available = cd.balance;
    } else if (input.payment_id) {
      const p = d.get<Row>('SELECT * FROM payments WHERE id = ?', input.payment_id) ?? fail('Payment not found', 404);
      kind = p.kind === 'received' ? 'customer' : 'vendor';
      contactId = p.contact_id;
      available = paymentUnused(p.id);
    } else return fail('Specify a credit or payment to refund', 422);
    if (amount > available + 0.001) fail(`Only ₹${available} is available to refund`, 422);
    const account = d.get<Row>('SELECT * FROM accounts WHERE id = ?', input.account_id) ?? fail('Account not found', 422);
    if (!['cash', 'bank', 'credit_card'].includes(account.type)) fail('Choose a cash or bank account', 422);
    assertUnlocked(kind === 'customer' ? 'sales' : 'purchases', date, 'refund');
    const id = d.insert('refunds', { kind, credit_doc_id: input.credit_doc_id ?? null, payment_id: input.payment_id ?? null, contact_id: contactId, date, amount, account_id: account.id, mode: input.mode ?? 'bank_transfer', reference: input.reference ?? null });
    const party = kind === 'customer' ? acct('accounts_receivable') : acct('accounts_payable');
    replaceJournal('refund', id, {
      date, memo: `Refund to ${kind}`, reference: input.reference ?? null,
      lines: kind === 'customer'
        ? [{ account_id: party, debit: amount, contact_id: contactId }, { account_id: account.id, credit: amount, contact_id: contactId }]
        : [{ account_id: account.id, debit: amount, contact_id: contactId }, { account_id: party, credit: amount, contact_id: contactId }],
    });
    if (input.credit_doc_id) refreshBalance(input.credit_doc_id);
    audit('refund', id, 'created', `Refund of ₹${amount} recorded`, user);
    return id;
  });
}

export function deleteRefund(id: number, user?: AuthUser) {
  db().tx(() => {
    const r = db().get<Row>('SELECT * FROM refunds WHERE id = ?', id) ?? fail('Refund not found', 404);
    assertUnlocked(r.kind === 'customer' ? 'sales' : 'purchases', r.date, 'refund');
    replaceJournal('refund', id, null);
    db().run('DELETE FROM refunds WHERE id = ?', id);
    if (r.credit_doc_id) refreshBalance(r.credit_doc_id);
    audit('refund', id, 'deleted', `Refund of ₹${r.amount} deleted`, user);
  });
}

/** Open documents a payment can be allocated to (used by the payment form). */
export function openDocumentsFor(contactId: number, kind: 'received' | 'made') {
  return db().all<Row>(
    `SELECT id, type, number, date, due_date, total, balance, currency_code FROM documents
     WHERE contact_id = ? AND type IN (${PAYABLE_DOCS[kind].map(() => '?').join(',')}) AND status IN ('open','partially_paid') ORDER BY date, id`,
    contactId, ...PAYABLE_DOCS[kind]);
}

export function availableCredits(contactId: number, kind: 'customer' | 'vendor') {
  const d = db();
  const docs = d.all<Row>(
    `SELECT id, type, number, date, total, balance FROM documents WHERE contact_id = ? AND type = ? AND status = 'open' AND balance > 0`,
    contactId, kind === 'customer' ? 'credit_note' : 'vendor_credit');
  const retainers = kind === 'customer'
    ? d.all<Row>(`SELECT id, type, number, date, total, balance FROM documents WHERE contact_id = ? AND type = 'retainer_invoice' AND status IN ('paid','open')`, contactId)
      .map((r) => ({ ...r, balance: r2(r.total - r.balance - creditUsed(r.id)) })).filter((r) => r.balance > 0)
    : [];
  const payments = d.all<Row>(`SELECT id, number, date, amount FROM payments WHERE contact_id = ? AND kind = ? AND status <> 'void'`, contactId, kind === 'customer' ? 'received' : 'made')
    .map((p) => ({ ...p, type: 'payment', balance: paymentUnused(p.id) })).filter((p) => p.balance > 0);
  return [...docs, ...retainers, ...payments];
}
