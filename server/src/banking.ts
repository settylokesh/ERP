import { audit } from './activity.js';
import type { AuthUser } from './auth.js';
import { db, fail, type Row } from './db.js';
import { accountBalance, assertNotReconciled, replaceJournal } from './ledger.js';
import { createPayment } from './payments.js';
import { assertUnlocked, nextNumber } from './settings.js';
import { addDays, isDate, r2, today } from './util.js';

const BANKISH = ['bank', 'cash', 'credit_card'];

export function bankAccounts() {
  const d = db();
  return d.all<Row>(`SELECT * FROM accounts WHERE type IN ('bank','cash','credit_card') AND is_active = 1 ORDER BY type, name`).map((a) => ({
    ...a,
    balance: accountBalance(a.id),
    uncategorized: d.value<number>("SELECT COUNT(*) FROM bank_statement_lines WHERE account_id = ? AND status = 'uncategorized'", a.id) ?? 0,
    statement_balance: r2(d.value<number>('SELECT COALESCE(SUM(deposit - withdrawal),0) FROM bank_statement_lines WHERE account_id = ?', a.id) ?? 0),
    last_reconciled: d.value<string>("SELECT MAX(end_date) FROM reconciliations WHERE account_id = ? AND status = 'completed'", a.id) ?? null,
  }));
}

const KINDS: Record<string, { label: string; direction: 'in' | 'out'; offsetTypes?: string[] }> = {
  transfer_in: { label: 'Transfer from Another Account', direction: 'in', offsetTypes: BANKISH },
  transfer_out: { label: 'Transfer to Another Account', direction: 'out', offsetTypes: BANKISH },
  deposit: { label: 'Deposit', direction: 'in' },
  other_income: { label: 'Other Income', direction: 'in', offsetTypes: ['income', 'other_income'] },
  interest_income: { label: 'Interest Income', direction: 'in', offsetTypes: ['income', 'other_income'] },
  owner_contribution: { label: "Owner's Contribution", direction: 'in', offsetTypes: ['equity'] },
  expense: { label: 'Expense', direction: 'out', offsetTypes: ['expense', 'cost_of_goods_sold', 'other_expense', 'fixed_asset', 'other_current_asset'] },
  owner_drawings: { label: 'Owner Drawings', direction: 'out', offsetTypes: ['equity'] },
  card_payment: { label: 'Card Payment', direction: 'out', offsetTypes: ['credit_card'] },
  tax_payment: { label: 'Tax Payment', direction: 'out', offsetTypes: ['other_current_liability'] },
  loan: { label: 'Loan Received', direction: 'in', offsetTypes: ['long_term_liability', 'other_current_liability'] },
  loan_repayment: { label: 'Loan Repayment', direction: 'out', offsetTypes: ['long_term_liability', 'other_current_liability'] },
};
export const BANK_TXN_KINDS = KINDS;

export function saveBankTransaction(input: Row, user?: AuthUser, id?: number) {
  return db().tx(() => {
    const d = db();
    const k = KINDS[input.kind] ?? fail('Invalid transaction type', 422);
    const account = d.get<Row>('SELECT * FROM accounts WHERE id = ?', input.account_id) ?? fail('Account not found', 422);
    if (!BANKISH.includes(account.type)) fail('Choose a bank, cash or card account', 422);
    const offset = d.get<Row>('SELECT * FROM accounts WHERE id = ?', input.offset_account_id) ?? fail('Choose the other account', 422);
    if (offset.id === account.id) fail('From and to accounts must differ', 422);
    if (k.offsetTypes && !k.offsetTypes.includes(offset.type)) fail(`${offset.name} cannot be used for ${k.label}`, 422);
    if (['accounts_receivable', 'accounts_payable', 'stock'].includes(offset.type)) fail('Use payments or inventory transactions for this account', 422);
    const amount = r2(Number(input.amount));
    if (!(amount > 0)) fail('Amount must be greater than zero', 422);
    const date = input.date ?? today();
    if (!isDate(date)) fail('Date is invalid', 422);
    assertUnlocked('banking', date, 'bank transaction');
    const row = { kind: input.kind, date, account_id: account.id, offset_account_id: offset.id, amount, direction: k.direction, contact_id: input.contact_id || null, description: input.description ?? null, reference: input.reference ?? null };
    let tid = id;
    if (id) {
      const ex = d.get<Row>('SELECT * FROM bank_transactions WHERE id = ?', id) ?? fail('Transaction not found', 404);
      assertUnlocked('banking', ex.date, 'bank transaction');
      assertNotReconciled('bank_txn', id, 'edit');
      d.update('bank_transactions', id, row);
    } else tid = d.insert('bank_transactions', { ...row, number: nextNumber('bank_txn') });
    replaceJournal('bank_txn', tid!, {
      date, memo: `${k.label}${row.description ? ` - ${row.description}` : ''}`, reference: row.reference,
      lines: k.direction === 'in'
        ? [{ account_id: account.id, debit: amount, contact_id: row.contact_id }, { account_id: offset.id, credit: amount, contact_id: row.contact_id }]
        : [{ account_id: offset.id, debit: amount, contact_id: row.contact_id }, { account_id: account.id, credit: amount, contact_id: row.contact_id }],
    });
    audit('bank_txn', tid!, id ? 'updated' : 'created', `${k.label} of ₹${amount}`, user);
    return tid!;
  });
}

export function deleteBankTransaction(id: number, user?: AuthUser) {
  db().tx(() => {
    const d = db();
    const t = d.get<Row>('SELECT * FROM bank_transactions WHERE id = ?', id) ?? fail('Transaction not found', 404);
    assertUnlocked('banking', t.date, 'bank transaction');
    assertNotReconciled('bank_txn', id, 'delete');
    replaceJournal('bank_txn', id, null);
    d.run('DELETE FROM bank_transactions WHERE id = ?', id);
    audit('bank_txn', id, 'deleted', `Bank transaction ${t.number} deleted`, user);
  });
}

// ---------------- Statement import & categorisation ----------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}
export { parseCsv };

function normDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isDate(iso) ? iso : null;
  }
  return null;
}
const money = (s: string | undefined) => {
  if (!s) return 0;
  const n = parseFloat(s.replace(/[₹,\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return Number.isFinite(n) ? n : 0;
};

/** Imports a bank statement CSV. Accepts Date, Description, Reference and either Deposit/Withdrawal or Amount columns. */
export function importStatement(accountId: number, csv: string, user?: AuthUser) {
  const d = db();
  const a = d.get<Row>('SELECT * FROM accounts WHERE id = ?', accountId) ?? fail('Account not found', 404);
  if (!BANKISH.includes(a.type)) fail('Statements can only be imported into bank, cash or card accounts', 422);
  const rows = parseCsv(csv);
  if (rows.length < 2) fail('The file has no transactions', 422);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = col('date'), iDesc = col('description', 'narration', 'particulars', 'details'), iRef = col('reference', 'ref', 'cheque', 'chq');
  const iDep = col('deposit', 'credit'), iWd = col('withdrawal', 'debit'), iAmt = col('amount');
  if (iDate < 0 || (iAmt < 0 && (iDep < 0 || iWd < 0))) fail('CSV needs a Date column and either Amount or Deposit/Withdrawal columns', 422);
  const batch = `IMP-${Date.now()}`;
  let imported = 0, skipped = 0;
  d.tx(() => {
    for (const r of rows.slice(1)) {
      const date = normDate(r[iDate] ?? '');
      if (!date) { skipped++; continue; }
      let deposit = 0, withdrawal = 0;
      if (iAmt >= 0 && (iDep < 0 || iWd < 0)) {
        const amt = money(r[iAmt]);
        if (amt >= 0) deposit = amt; else withdrawal = -amt;
      } else {
        deposit = Math.abs(money(r[iDep]));
        withdrawal = Math.abs(money(r[iWd]));
      }
      if (!deposit && !withdrawal) { skipped++; continue; }
      const description = iDesc >= 0 ? r[iDesc]?.trim() : '';
      const reference = iRef >= 0 ? r[iRef]?.trim() : '';
      if (d.get('SELECT 1 FROM bank_statement_lines WHERE account_id = ? AND date = ? AND deposit = ? AND withdrawal = ? AND COALESCE(description,\'\') = ? AND COALESCE(reference,\'\') = ?',
        accountId, date, r2(deposit), r2(withdrawal), description ?? '', reference ?? '')) { skipped++; continue; }
      d.insert('bank_statement_lines', { account_id: accountId, date, description, reference, deposit: r2(deposit), withdrawal: r2(withdrawal), import_batch: batch });
      imported++;
    }
  });
  audit('bank_statement', accountId, 'imported', `Imported ${imported} statement lines (${skipped} skipped)`, user);
  return { imported, skipped, batch };
}

export function statementLines(accountId: number, status?: string) {
  return db().all<Row>(
    `SELECT * FROM bank_statement_lines WHERE account_id = ? ${status ? 'AND status = ?' : ''} ORDER BY date DESC, id DESC LIMIT 1000`,
    ...(status ? [accountId, status] : [accountId]));
}

/** Ledger postings on the bank account that could correspond to a statement line (same amount and direction, ±7 days). */
export function matchSuggestions(lineId: number) {
  const d = db();
  const l = d.get<Row>('SELECT * FROM bank_statement_lines WHERE id = ?', lineId) ?? fail('Statement line not found', 404);
  const amt = l.deposit || l.withdrawal;
  const isIn = l.deposit > 0;
  const matched = d.all<Row>("SELECT matched_source_type t, matched_source_id i FROM bank_statement_lines WHERE status = 'matched' AND matched_source_type IS NOT NULL");
  const taken = new Set(matched.map((m) => `${m.t}:${m.i}`));
  const candidates = d.all<Row>(
    `SELECT j.source_type, j.source_id, j.date, j.memo, j.reference, ${isIn ? 'SUM(jl.debit)' : 'SUM(jl.credit)'} AS amount
     FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
     WHERE jl.account_id = ? AND j.date BETWEEN ? AND ? AND j.status = 'posted' GROUP BY j.id HAVING ABS(amount - ?) < 0.005`,
    l.account_id, addDays(l.date, -7), addDays(l.date, 7), amt);
  return candidates.filter((c) => !taken.has(`${c.source_type}:${c.source_id}`))
    .sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(l.date)) - Math.abs(Date.parse(b.date) - Date.parse(l.date)));
}

export function matchLine(lineId: number, sourceType: string, sourceId: number, user?: AuthUser) {
  const ok = matchSuggestions(lineId).some((c) => c.source_type === sourceType && c.source_id === sourceId);
  if (!ok) fail('That transaction does not match this statement line', 422);
  db().update('bank_statement_lines', lineId, { status: 'matched', matched_source_type: sourceType, matched_source_id: sourceId });
  audit('bank_statement', lineId, 'matched', `Statement line matched to ${sourceType} #${sourceId}`, user);
}

/** Creates the accounting transaction for an unmatched statement line and links it. */
export function categorizeLine(lineId: number, input: Row, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const l = d.get<Row>('SELECT * FROM bank_statement_lines WHERE id = ?', lineId) ?? fail('Statement line not found', 404);
    if (l.status !== 'uncategorized') fail('This line is already categorised', 422);
    const amount = l.deposit || l.withdrawal;
    const isIn = l.deposit > 0;
    let source: [string, number];
    if (input.kind === 'customer_payment' || input.kind === 'vendor_payment') {
      if ((input.kind === 'customer_payment') !== isIn) fail(isIn ? 'Deposits can only be customer payments' : 'Withdrawals can only be vendor payments', 422);
      const pid = createPayment({
        kind: isIn ? 'received' : 'made', date: l.date, contact_id: input.contact_id, amount, account_id: l.account_id,
        mode: 'bank_transfer', reference: l.reference || l.description, allocations: input.allocations ?? [],
      }, user);
      source = ['payment', pid];
    } else {
      const k = KINDS[input.kind] ?? fail('Choose a category', 422);
      if ((k.direction === 'in') !== isIn) fail(`${k.label} does not match the direction of this line`, 422);
      const tid = saveBankTransaction({ kind: input.kind, date: l.date, account_id: l.account_id, offset_account_id: input.offset_account_id, amount, contact_id: input.contact_id, description: input.description ?? l.description, reference: l.reference }, user);
      source = ['bank_txn', tid];
    }
    d.update('bank_statement_lines', lineId, { status: 'categorized', matched_source_type: source[0], matched_source_id: source[1] });
    return { source_type: source[0], source_id: source[1] };
  });
}

export function setLineStatus(lineId: number, status: 'excluded' | 'uncategorized') {
  const l = db().get<Row>('SELECT * FROM bank_statement_lines WHERE id = ?', lineId) ?? fail('Statement line not found', 404);
  if (status === 'uncategorized' && l.status === 'categorized') fail('Delete the categorised transaction to undo', 422);
  db().update('bank_statement_lines', lineId, { status, matched_source_type: null, matched_source_id: null });
}

// ---------------- Reconciliation ----------------

export function reconciliationData(accountId: number, endDate: string, reconId?: number) {
  const d = db();
  const a = d.get<Row>('SELECT * FROM accounts WHERE id = ?', accountId) ?? fail('Account not found', 404);
  const last = d.get<Row>("SELECT * FROM reconciliations WHERE account_id = ? AND status = 'completed' ORDER BY end_date DESC LIMIT 1", accountId);
  const opening = last ? last.closing_balance : 0;
  const sign = a.type === 'credit_card' ? -1 : 1;
  const lines = d.all<Row>(
    `SELECT jl.id, j.date, j.source_type, j.source_id, j.memo, j.reference, jl.debit, jl.credit, jl.recon_id, c.name AS contact_name
     FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id LEFT JOIN contacts c ON c.id = jl.contact_id
     WHERE jl.account_id = ? AND j.status = 'posted' AND j.date <= ? AND (jl.recon_id IS NULL OR jl.recon_id = ?)
     ORDER BY j.date, j.id`, accountId, endDate, reconId ?? -1)
    .map((l) => ({ ...l, amount: r2(sign * (l.debit - l.credit)) }));
  return { account: a, opening, lines, last_reconciled: last?.end_date ?? null };
}

export function completeReconciliation(input: Row, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const accountId = Number(input.account_id);
    const endDate = input.end_date;
    if (!isDate(endDate)) fail('Statement end date is invalid', 422);
    const { opening, lines, last_reconciled } = reconciliationData(accountId, endDate);
    if (last_reconciled && endDate <= last_reconciled) fail(`The account is already reconciled up to ${last_reconciled}`, 422);
    const ids = new Set<number>((input.cleared_line_ids ?? []).map(Number));
    const cleared = lines.filter((l) => ids.has(l.id));
    if (cleared.length !== ids.size) fail('Some selected transactions are not available for reconciliation', 422);
    const closing = r2(Number(input.closing_balance));
    const clearedBalance = r2(opening + cleared.reduce((a, l) => a + l.amount, 0));
    if (Math.abs(clearedBalance - closing) > 0.004) fail(`Cleared balance ₹${clearedBalance} does not match the statement closing balance ₹${closing} (difference ₹${r2(closing - clearedBalance)})`, 422);
    const rid = d.insert('reconciliations', { account_id: accountId, start_date: input.start_date ?? last_reconciled ?? endDate, end_date: endDate, closing_balance: closing, status: 'completed', completed_at: new Date().toISOString() });
    for (const l of cleared) d.run('UPDATE journal_lines SET recon_id = ? WHERE id = ?', rid, l.id);
    audit('reconciliation', rid, 'completed', `Account reconciled up to ${endDate}`, user);
    return rid;
  });
}

export function undoReconciliation(id: number, user?: AuthUser) {
  db().tx(() => {
    const d = db();
    const r = d.get<Row>('SELECT * FROM reconciliations WHERE id = ?', id) ?? fail('Reconciliation not found', 404);
    const later = d.get("SELECT 1 FROM reconciliations WHERE account_id = ? AND status = 'completed' AND end_date > ?", r.account_id, r.end_date);
    if (later) fail('Undo the later reconciliations first', 422);
    d.run('UPDATE journal_lines SET recon_id = NULL WHERE recon_id = ?', id);
    d.run('DELETE FROM reconciliations WHERE id = ?', id);
    audit('reconciliation', id, 'undone', 'Reconciliation undone', user);
  });
}

export function listReconciliations(accountId: number) {
  return db().all<Row>('SELECT * FROM reconciliations WHERE account_id = ? ORDER BY end_date DESC', accountId);
}
