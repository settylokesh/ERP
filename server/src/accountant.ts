import { audit } from './activity.js';
import type { AuthUser } from './auth.js';
import { db, fail, json, type Row } from './db.js';
import { acct, accountBalance, categoryOf, journalsFor, normaliseLines, replaceJournal, type JLine } from './ledger.js';
import { assertUnlocked, nextNumber, org } from './settings.js';
import { addMonths, fiscalYear, isDate, monthEnd, r2, today } from './util.js';

// ---------------- Manual journals ----------------

function validateJournalLines(lines: Row[]): JLine[] {
  const d = db();
  if (!Array.isArray(lines) || lines.length < 2) fail('A journal needs at least two lines', 422);
  const out: JLine[] = lines.map((l, i) => {
    const a = d.get<Row>('SELECT * FROM accounts WHERE id = ?', l.account_id) ?? fail(`Line ${i + 1}: account not found`, 422);
    const debit = r2(Number(l.debit || 0)), credit = r2(Number(l.credit || 0));
    if (debit < 0 || credit < 0) fail(`Line ${i + 1}: amounts cannot be negative`, 422);
    if (debit && credit) fail(`Line ${i + 1}: enter either a debit or a credit`, 422);
    if (!debit && !credit) fail(`Line ${i + 1}: enter an amount`, 422);
    if (['accounts_receivable', 'accounts_payable'].includes(a.type) && !l.contact_id) fail(`Line ${i + 1}: choose a contact for ${a.name}`, 422);
    if (a.type === 'stock') fail(`Line ${i + 1}: inventory accounts are maintained through inventory transactions`, 422);
    return { account_id: a.id, debit, credit, contact_id: l.contact_id || null, description: l.description ?? null };
  });
  normaliseLines(out);
  return out;
}

export function saveManualJournal(input: Row, user?: AuthUser, id?: number) {
  return db().tx(() => {
    const d = db();
    const date = input.date ?? today();
    if (!isDate(date)) fail('Journal date is invalid', 422);
    assertUnlocked('accountant', date, 'journal');
    const lines = validateJournalLines(input.lines);
    const status = input.status === 'draft' ? 'draft' : 'posted';
    let jid = id;
    if (id) {
      const j = d.get<Row>('SELECT * FROM journals WHERE id = ? AND is_manual = 1', id) ?? fail('Journal not found', 404);
      assertUnlocked('accountant', j.date, 'journal');
      if (d.get('SELECT 1 FROM journal_lines WHERE journal_id = ? AND recon_id IS NOT NULL', id)) fail('This journal has reconciled bank lines. Undo the reconciliation first.', 422);
      d.update('journals', id, { date, reference: input.reference ?? null, memo: input.memo ?? null, status });
      d.run('DELETE FROM journal_lines WHERE journal_id = ?', id);
    } else {
      jid = d.insert('journals', { number: nextNumber('journal'), date, source_type: 'manual_journal', reference: input.reference ?? null, memo: input.memo ?? null, is_manual: 1, status, created_by: user?.id ?? null, data: JSON.stringify({ journal_type: input.journal_type ?? 'both' }) });
      d.update('journals', jid!, { source_id: jid });
    }
    for (const l of lines) d.insert('journal_lines', { journal_id: jid, ...l });
    audit('journal', jid!, id ? 'updated' : 'created', `Manual journal ${id ? 'updated' : 'created'} (${status})`, user);
    return jid!;
  });
}

export function deleteManualJournal(id: number, user?: AuthUser) {
  const d = db();
  const j = d.get<Row>('SELECT * FROM journals WHERE id = ? AND is_manual = 1', id) ?? fail('Journal not found', 404);
  assertUnlocked('accountant', j.date, 'journal');
  if (d.get('SELECT 1 FROM journal_lines WHERE journal_id = ? AND recon_id IS NOT NULL', id)) fail('Undo the bank reconciliation first', 422);
  d.run('DELETE FROM journals WHERE id = ?', id);
  audit('journal', id, 'deleted', `Manual journal ${j.number} deleted`, user);
}

export function reverseManualJournal(id: number, date: string, user?: AuthUser) {
  const d = db();
  const j = d.get<Row>('SELECT * FROM journals WHERE id = ? AND is_manual = 1', id) ?? fail('Journal not found', 404);
  const lines = d.all<Row>('SELECT * FROM journal_lines WHERE journal_id = ?', id);
  return saveManualJournal({
    date: date || today(), reference: j.number, memo: `Reversal of ${j.number}${j.memo ? ` - ${j.memo}` : ''}`,
    lines: lines.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, contact_id: l.contact_id, description: l.description })),
  }, user);
}

export function listManualJournals(q: Row) {
  const where = ['j.is_manual = 1'];
  const params: unknown[] = [];
  if (q.from) { where.push('j.date >= ?'); params.push(q.from); }
  if (q.to) { where.push('j.date <= ?'); params.push(q.to); }
  if (q.search) { where.push('(j.number LIKE ? OR j.reference LIKE ? OR j.memo LIKE ?)'); params.push(...Array(3).fill(`%${q.search}%`)); }
  return db().all<Row>(
    `SELECT j.*, (SELECT SUM(debit) FROM journal_lines WHERE journal_id = j.id) AS amount FROM journals j WHERE ${where.join(' AND ')} ORDER BY j.date DESC, j.id DESC LIMIT 500`, ...params);
}

export function getManualJournal(id: number) {
  const d = db();
  const j = d.get<Row>('SELECT * FROM journals WHERE id = ?', id) ?? fail('Journal not found', 404);
  const lines = d.all<Row>(
    `SELECT jl.*, a.name AS account_name, a.code AS account_code, c.name AS contact_name FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     LEFT JOIN contacts c ON c.id = jl.contact_id WHERE jl.journal_id = ? ORDER BY jl.id`, id);
  return { ...j, data: json(j.data, {}), lines };
}

/** Ledger lines of one account with a running balance. */
export function accountTransactions(accountId: number, from?: string, to?: string) {
  const d = db();
  const a = d.get<Row>('SELECT * FROM accounts WHERE id = ?', accountId) ?? fail('Account not found', 404);
  const debitNature = ['asset', 'expense'].includes(categoryOf(a.type));
  const opening = from ? accountBalance(accountId, new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10)) : 0;
  let running = opening;
  const rows = d.all<Row>(
    `SELECT jl.id, j.id AS journal_id, j.date, j.source_type, j.source_id, j.memo, j.reference, j.number, jl.debit, jl.credit, jl.description, jl.recon_id,
            c.name AS contact_name
     FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id LEFT JOIN contacts c ON c.id = jl.contact_id
     WHERE jl.account_id = ? AND j.status = 'posted' AND (? IS NULL OR j.date >= ?) AND (? IS NULL OR j.date <= ?)
     ORDER BY j.date, j.id, jl.id`, accountId, from ?? null, from ?? null, to ?? null, to ?? null).map((r) => {
    running = r2(running + (debitNature ? r.debit - r.credit : r.credit - r.debit));
    return { ...r, balance: running };
  });
  return { account: { ...a, category: categoryOf(a.type) }, opening, closing: running, rows };
}

// ---------------- Fixed assets ----------------

export function saveAssetType(input: Row, id?: number) {
  const d = db();
  const name = String(input.name ?? '').trim() || fail('Asset type name is required', 422);
  for (const k of ['asset_account_id', 'depreciation_account_id', 'accumulated_account_id']) {
    if (!d.get('SELECT 1 FROM accounts WHERE id = ?', input[k])) fail(`Choose the ${k.replace('_account_id', '').replace('_', ' ')} account`, 422);
  }
  const row = { name, asset_account_id: input.asset_account_id, depreciation_account_id: input.depreciation_account_id, accumulated_account_id: input.accumulated_account_id, method: input.method === 'wdv' ? 'wdv' : 'slm', useful_life_months: Math.max(1, Number(input.useful_life_months) || 60), wdv_rate: Number(input.wdv_rate) || 0 };
  if (id) { d.update('asset_types', id, row); return id; }
  return d.insert('asset_types', row);
}

export function saveAsset(input: Row, user?: AuthUser, id?: number) {
  return db().tx(() => {
    const d = db();
    const existing = id ? d.get<Row>('SELECT * FROM assets WHERE id = ?', id) ?? fail('Asset not found', 404) : null;
    if (existing && existing.status !== 'draft') fail('Only draft assets can be edited', 422);
    const type = d.get<Row>('SELECT * FROM asset_types WHERE id = ?', input.asset_type_id) ?? fail('Asset type not found', 422);
    const cost = r2(Number(input.cost));
    if (!(cost > 0)) fail('Asset cost must be greater than zero', 422);
    const salvage = r2(Number(input.salvage_value ?? 0));
    if (salvage < 0 || salvage >= cost) fail('Salvage value must be less than the cost', 422);
    const purchase_date = input.purchase_date ?? today();
    const depreciation_start = input.depreciation_start ?? purchase_date;
    if (!isDate(purchase_date) || !isDate(depreciation_start)) fail('Dates are invalid', 422);
    if (depreciation_start < purchase_date) fail('Depreciation cannot start before the purchase date', 422);
    const method = input.method ?? type.method;
    const row = {
      name: String(input.name ?? '').trim() || fail('Asset name is required', 422), asset_type_id: type.id, serial_no: input.serial_no ?? null, location: input.location ?? null,
      purchase_date, depreciation_start, cost, salvage_value: salvage, method: method === 'wdv' ? 'wdv' : 'slm',
      useful_life_months: Math.max(1, Number(input.useful_life_months ?? type.useful_life_months)), wdv_rate: Number(input.wdv_rate ?? type.wdv_rate) || 0,
      vendor_id: input.vendor_id || null, acquisition_account_id: input.acquisition_account_id || null, notes: input.notes ?? null,
    };
    if (row.method === 'wdv' && !(row.wdv_rate > 0 && row.wdv_rate < 100)) fail('WDV rate must be between 0 and 100', 422);
    const aid = existing ? (d.update('assets', existing.id, row), existing.id) : d.insert('assets', { ...row, number: nextNumber('asset'), status: 'draft' });
    audit('asset', aid, existing ? 'updated' : 'created', `Fixed asset ${row.name}`, user);
    return aid;
  });
}

export function registerAsset(id: number, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const a = d.get<Row>('SELECT a.*, t.asset_account_id FROM assets a JOIN asset_types t ON t.id = a.asset_type_id WHERE a.id = ?', id) ?? fail('Asset not found', 404);
    if (a.status !== 'draft') fail('Asset is already registered', 422);
    if (a.acquisition_account_id) {
      assertUnlocked('accountant', a.purchase_date, 'asset');
      replaceJournal('asset_acquisition', id, {
        date: a.purchase_date, memo: `Acquisition of ${a.number} ${a.name}`,
        lines: [{ account_id: a.asset_account_id, debit: a.cost }, { account_id: a.acquisition_account_id, credit: a.cost, contact_id: a.vendor_id }],
      });
    }
    d.update('assets', id, { status: 'active' });
    audit('asset', id, 'registered', `Asset ${a.number} registered`, user);
  });
}

/** Planned depreciation per month until book value reaches salvage value. */
export function depreciationSchedule(a: Row) {
  const startMonth = org().fiscal_year_start_month;
  const out: { period_end: string; amount: number; book_value: number }[] = [];
  let bv = a.cost;
  let period = monthEnd(a.depreciation_start);
  let annual = 0;
  let fyStart = '';
  for (let i = 0; i < 600 && bv > a.salvage_value + 0.004; i++) {
    let amt: number;
    if (a.method === 'slm') amt = r2((a.cost - a.salvage_value) / a.useful_life_months);
    else {
      const fy = fiscalYear(period, startMonth).start;
      if (fy !== fyStart) { fyStart = fy; annual = bv * a.wdv_rate / 100; }
      amt = r2(annual / 12);
      if (amt < 0.01) amt = r2(bv - a.salvage_value);
    }
    amt = Math.min(amt, r2(bv - a.salvage_value));
    bv = r2(bv - amt);
    out.push({ period_end: period, amount: amt, book_value: bv });
    period = monthEnd(addMonths(period.slice(0, 8) + '01', 1));
  }
  return out;
}

export function runDepreciation(upto: string, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    let posted = 0;
    for (const a of d.all<Row>("SELECT a.*, t.depreciation_account_id, t.accumulated_account_id FROM assets a JOIN asset_types t ON t.id = a.asset_type_id WHERE a.status = 'active'")) {
      for (const p of depreciationSchedule(a)) {
        if (p.period_end > upto) break;
        if (a.disposal_date && p.period_end > a.disposal_date) break;
        if (d.get('SELECT 1 FROM asset_depreciation WHERE asset_id = ? AND period_end = ?', a.id, p.period_end)) continue;
        assertUnlocked('accountant', p.period_end, 'depreciation');
        const depId = d.insert('asset_depreciation', { asset_id: a.id, period_end: p.period_end, amount: p.amount });
        const jid = replaceJournal('asset_depreciation', depId, {
          date: p.period_end, memo: `Depreciation ${a.number} ${a.name} (${p.period_end.slice(0, 7)})`,
          lines: [{ account_id: a.depreciation_account_id, debit: p.amount }, { account_id: a.accumulated_account_id, credit: p.amount }],
        });
        d.update('asset_depreciation', depId, { journal_id: jid });
        posted++;
        if (p.book_value <= a.salvage_value + 0.004) d.update('assets', a.id, { status: 'fully_depreciated' });
      }
    }
    audit('asset', null, 'depreciation', `Depreciation run up to ${upto}: ${posted} entries`, user);
    return posted;
  });
}

export function disposeAsset(id: number, input: Row, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const a = d.get<Row>('SELECT a.*, t.asset_account_id, t.accumulated_account_id FROM assets a JOIN asset_types t ON t.id = a.asset_type_id WHERE a.id = ?', id) ?? fail('Asset not found', 404);
    if (!['active', 'fully_depreciated'].includes(a.status)) fail('Only registered assets can be disposed', 422);
    const date = input.date ?? today();
    assertUnlocked('accountant', date, 'asset disposal');
    if (d.get('SELECT 1 FROM asset_depreciation WHERE asset_id = ? AND period_end > ?', id, date)) fail('Depreciation is already posted after the disposal date', 422);
    const accumulated = d.value<number>('SELECT COALESCE(SUM(amount),0) FROM asset_depreciation WHERE asset_id = ?', id) ?? 0;
    const proceeds = r2(Number(input.amount ?? 0));
    if (proceeds < 0) fail('Sale amount cannot be negative', 422);
    const lines: JLine[] = [
      { account_id: a.accumulated_account_id, debit: accumulated },
      { account_id: a.asset_account_id, credit: a.cost },
    ];
    if (proceeds) {
      const acc = d.get<Row>('SELECT * FROM accounts WHERE id = ?', input.account_id) ?? fail('Choose the account that received the sale proceeds', 422);
      lines.push({ account_id: acc.id, debit: proceeds });
    }
    const gain = r2(proceeds - (a.cost - accumulated));
    lines.push({ account_id: acct('asset_disposal'), debit: gain < 0 ? -gain : 0, credit: gain > 0 ? gain : 0 });
    replaceJournal('asset_disposal', id, { date, memo: `Disposal of ${a.number} ${a.name}`, lines });
    d.update('assets', id, { status: 'disposed', disposal_date: date, disposal_amount: proceeds, disposal_account_id: input.account_id ?? null });
    audit('asset', id, 'disposed', `Asset ${a.number} disposed for ₹${proceeds} (gain/loss ₹${gain})`, user);
    return { gain };
  });
}

export function getAsset(id: number) {
  const d = db();
  const a = d.get<Row>('SELECT a.*, t.name AS type_name FROM assets a JOIN asset_types t ON t.id = a.asset_type_id WHERE a.id = ?', id) ?? fail('Asset not found', 404);
  const posted = d.all<Row>('SELECT * FROM asset_depreciation WHERE asset_id = ? ORDER BY period_end', id);
  const accumulated = r2(posted.reduce((s, p) => s + p.amount, 0));
  return {
    ...a, accumulated, book_value: a.status === 'disposed' ? 0 : r2(a.cost - accumulated), posted,
    schedule: depreciationSchedule(a).map((p) => ({ ...p, posted: posted.some((x) => x.period_end === p.period_end) })),
    journal: [...journalsFor('asset_acquisition', id), ...journalsFor('asset_disposal', id)],
  };
}

export function listAssets() {
  return db().all<Row>(
    `SELECT a.*, t.name AS type_name, COALESCE((SELECT SUM(amount) FROM asset_depreciation WHERE asset_id = a.id), 0) AS accumulated
     FROM assets a JOIN asset_types t ON t.id = a.asset_type_id ORDER BY a.purchase_date DESC, a.id DESC`)
    .map((a) => ({ ...a, accumulated: r2(a.accumulated), book_value: a.status === 'disposed' ? 0 : r2(a.cost - a.accumulated) }));
}

// ---------------- Budgets ----------------

export function saveBudget(input: Row, id?: number) {
  return db().tx(() => {
    const d = db();
    const name = String(input.name ?? '').trim() || fail('Budget name is required', 422);
    const fiscal_year = Number(input.fiscal_year);
    if (!(fiscal_year > 2000 && fiscal_year < 2100)) fail('Fiscal year is invalid', 422);
    const row = { name, fiscal_year, period: 'monthly' };
    const bid = id ? (d.update('budgets', id, row), id) : d.insert('budgets', row);
    d.run('DELETE FROM budget_lines WHERE budget_id = ?', bid);
    for (const l of input.lines ?? []) {
      const a = d.get<Row>('SELECT * FROM accounts WHERE id = ?', l.account_id) ?? fail('Account not found', 422);
      const amounts: number[] = Array.from({ length: 12 }, (_, i) => r2(Number(l.amounts?.[i] ?? 0)));
      d.insert('budget_lines', { budget_id: bid, account_id: a.id, amounts: JSON.stringify(amounts) });
    }
    return bid;
  });
}

export function budgetVsActual(id: number) {
  const d = db();
  const b = d.get<Row>('SELECT * FROM budgets WHERE id = ?', id) ?? fail('Budget not found', 404);
  const startMonth = org().fiscal_year_start_month;
  const start = `${b.fiscal_year}-${String(startMonth).padStart(2, '0')}-01`;
  const months = Array.from({ length: 12 }, (_, i) => addMonths(start, i));
  const lines = d.all<Row>('SELECT bl.*, a.name AS account_name, a.type FROM budget_lines bl JOIN accounts a ON a.id = bl.account_id WHERE bl.budget_id = ?', id).map((l) => {
    const budget = json<number[]>(l.amounts, []);
    const actual = months.map((m) => {
      const raw = d.value<number>(
        `SELECT COALESCE(SUM(jl.debit - jl.credit),0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
         WHERE jl.account_id = ? AND j.status = 'posted' AND j.date BETWEEN ? AND ?`, l.account_id, m, monthEnd(m)) ?? 0;
      return r2(categoryOf(l.type) === 'income' || ['liability', 'equity'].includes(categoryOf(l.type)) ? -raw : raw);
    });
    const tb = r2(budget.reduce((a, x) => a + x, 0)), ta = r2(actual.reduce((a, x) => a + x, 0));
    return { account_id: l.account_id, account_name: l.account_name, category: categoryOf(l.type), budget, actual, total_budget: tb, total_actual: ta, variance: r2(ta - tb), variance_pct: tb ? r2(((ta - tb) / tb) * 100) : null };
  });
  return { ...b, months: months.map((m) => m.slice(0, 7)), lines };
}
