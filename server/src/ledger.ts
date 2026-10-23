import { db, fail, type DB, type Row } from './db.js';
import { r2 } from './util.js';

export const ACCOUNT_TYPES: Record<string, { label: string; category: 'asset' | 'liability' | 'equity' | 'income' | 'expense' }> = {
  cash: { label: 'Cash', category: 'asset' },
  bank: { label: 'Bank', category: 'asset' },
  accounts_receivable: { label: 'Accounts Receivable', category: 'asset' },
  other_current_asset: { label: 'Other Current Asset', category: 'asset' },
  stock: { label: 'Stock', category: 'asset' },
  fixed_asset: { label: 'Fixed Asset', category: 'asset' },
  other_asset: { label: 'Other Asset', category: 'asset' },
  credit_card: { label: 'Credit Card', category: 'liability' },
  accounts_payable: { label: 'Accounts Payable', category: 'liability' },
  other_current_liability: { label: 'Other Current Liability', category: 'liability' },
  long_term_liability: { label: 'Long Term Liability', category: 'liability' },
  other_liability: { label: 'Other Liability', category: 'liability' },
  equity: { label: 'Equity', category: 'equity' },
  income: { label: 'Income', category: 'income' },
  other_income: { label: 'Other Income', category: 'income' },
  expense: { label: 'Expense', category: 'expense' },
  cost_of_goods_sold: { label: 'Cost Of Goods Sold', category: 'expense' },
  other_expense: { label: 'Other Expense', category: 'expense' },
};
export const categoryOf = (type: string) => ACCOUNT_TYPES[type]?.category ?? 'asset';
export const isDebitNature = (type: string) => ['asset', 'expense'].includes(categoryOf(type));

/** [code, name, type, system_key] - the default chart of accounts for an Indian company. */
export const DEFAULT_ACCOUNTS: [string, string, string, string | null][] = [
  ['1000', 'Petty Cash', 'cash', 'petty_cash'],
  ['1010', 'Undeposited Funds', 'cash', 'undeposited_funds'],
  ['1100', 'Accounts Receivable', 'accounts_receivable', 'accounts_receivable'],
  ['1150', 'TDS Receivable', 'other_current_asset', 'tds_receivable'],
  ['1200', 'Inventory Asset', 'stock', 'inventory_asset'],
  ['1300', 'Input CGST', 'other_current_asset', 'input_cgst'],
  ['1301', 'Input SGST', 'other_current_asset', 'input_sgst'],
  ['1302', 'Input IGST', 'other_current_asset', 'input_igst'],
  ['1310', 'Prepaid Expenses', 'other_current_asset', 'prepaid_expenses'],
  ['1320', 'Employee Advances', 'other_current_asset', 'employee_advance'],
  ['1500', 'Furniture and Equipment', 'fixed_asset', 'furniture'],
  ['1510', 'Plant and Machinery', 'fixed_asset', 'machinery'],
  ['1520', 'Computers', 'fixed_asset', 'computers'],
  ['1590', 'Accumulated Depreciation', 'fixed_asset', 'accumulated_depreciation'],
  ['2000', 'Accounts Payable', 'accounts_payable', 'accounts_payable'],
  ['2100', 'Output CGST', 'other_current_liability', 'output_cgst'],
  ['2101', 'Output SGST', 'other_current_liability', 'output_sgst'],
  ['2102', 'Output IGST', 'other_current_liability', 'output_igst'],
  ['2110', 'Reverse Charge Tax Payable', 'other_current_liability', 'rcm_payable'],
  ['2120', 'TDS Payable', 'other_current_liability', 'tds_payable'],
  ['2121', 'TDS Payable - Salary', 'other_current_liability', 'tds_salary_payable'],
  ['2130', 'EPF Payable', 'other_current_liability', 'epf_payable'],
  ['2131', 'ESI Payable', 'other_current_liability', 'esi_payable'],
  ['2132', 'Professional Tax Payable', 'other_current_liability', 'pt_payable'],
  ['2133', 'Salary Payable', 'other_current_liability', 'salary_payable'],
  ['2300', 'Opening Balance Adjustments', 'other_current_liability', 'opening_balance_adjustments'],
  ['2400', 'Unearned Revenue', 'other_current_liability', 'unearned_revenue'],
  ['2500', 'Term Loan', 'long_term_liability', null],
  ['3000', 'Share Capital', 'equity', 'share_capital'],
  ['3100', 'Retained Earnings', 'equity', 'retained_earnings'],
  ['3200', 'Drawings', 'equity', 'drawings'],
  ['4000', 'Sales', 'income', 'sales'],
  ['4010', 'Service Income', 'income', 'service_income'],
  ['4100', 'Shipping Charge', 'income', 'shipping_charge'],
  ['4300', 'Other Income', 'other_income', 'other_income'],
  ['4320', 'Gain/Loss on Asset Disposal', 'other_income', 'asset_disposal'],
  ['4330', 'Interest Income', 'other_income', 'interest_income'],
  ['5000', 'Cost of Goods Sold', 'cost_of_goods_sold', 'cogs'],
  ['5010', 'Inventory Adjustments', 'cost_of_goods_sold', 'inventory_adjustment'],
  ['5100', 'Manufacturing Conversion Cost Absorbed', 'cost_of_goods_sold', 'mfg_absorption'],
  ['5200', 'Freight Inward', 'cost_of_goods_sold', 'freight_inward'],
  ['5300', 'Purchases - Raw Materials', 'cost_of_goods_sold', 'purchases'],
  ['6000', 'Salaries and Employee Wages', 'expense', 'salaries'],
  ['6010', 'Employer PF Contribution', 'expense', 'employer_pf'],
  ['6020', 'Employer ESI Contribution', 'expense', 'employer_esi'],
  ['6100', 'Rent Expense', 'expense', 'rent'],
  ['6110', 'Office Supplies', 'expense', 'office_supplies'],
  ['6120', 'Electricity and Utilities', 'expense', 'utilities'],
  ['6130', 'Travel Expense', 'expense', 'travel'],
  ['6140', 'Telephone and Internet', 'expense', 'telephone'],
  ['6150', 'Advertising and Marketing', 'expense', 'advertising'],
  ['6160', 'Repairs and Maintenance', 'expense', 'repairs'],
  ['6170', 'Professional Fees', 'expense', 'professional_fees'],
  ['6180', 'Bank Fees and Charges', 'expense', 'bank_charges'],
  ['6190', 'Depreciation Expense', 'expense', 'depreciation'],
  ['6200', 'Bad Debts', 'expense', 'bad_debts'],
  ['6900', 'Uncategorized Expense', 'expense', 'uncategorized'],
  ['7000', 'Rounding Off', 'other_expense', 'rounding'],
  ['7010', 'Exchange Gain or Loss', 'other_expense', 'exchange_gain_loss'],
  ['7100', 'Interest Expense', 'other_expense', 'interest_expense'],
];

const keyCache = new WeakMap<DB, Map<string, number>>();
/** Resolve a system account id by its stable key (e.g. 'accounts_receivable'). */
export function acct(key: string): number {
  const d = db();
  let m = keyCache.get(d);
  if (!m) keyCache.set(d, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const id = d.value<number>('SELECT id FROM accounts WHERE system_key = ?', key);
  if (!id) fail(`System account '${key}' is missing from the chart of accounts`, 500);
  m.set(key, id);
  return id;
}

export interface JLine {
  account_id: number;
  debit?: number;
  credit?: number;
  contact_id?: number | null;
  item_id?: number | null;
  description?: string | null;
}
export interface JournalSpec {
  date: string;
  source_type: string;
  source_id: number | null;
  memo?: string | null;
  reference?: string | null;
  number?: string | null;
  is_manual?: boolean;
  status?: string;
  created_by?: number | null;
  data?: Row;
  lines: JLine[];
}

/** Normalises lines (negative amounts flip sides, zero lines dropped) and verifies debits equal credits. */
export function normaliseLines(lines: JLine[]): JLine[] {
  const out: JLine[] = [];
  for (const l of lines) {
    let net = r2((l.debit ?? 0) - (l.credit ?? 0));
    if (Math.abs(net) < 0.005) continue;
    if (!l.account_id) fail('Journal line is missing an account', 500);
    out.push({ ...l, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
  }
  const dr = r2(out.reduce((a, l) => a + (l.debit ?? 0), 0));
  const cr = r2(out.reduce((a, l) => a + (l.credit ?? 0), 0));
  if (Math.abs(dr - cr) > 0.001) fail(`Journal is not balanced (debits ${dr} ≠ credits ${cr})`, 422);
  return out;
}

export function postJournal(spec: JournalSpec): number | null {
  const lines = normaliseLines(spec.lines);
  if (!lines.length && !spec.is_manual) return null;
  const d = db();
  const id = d.insert('journals', {
    number: spec.number ?? null,
    date: spec.date,
    source_type: spec.source_type,
    source_id: spec.source_id,
    memo: spec.memo ?? null,
    reference: spec.reference ?? null,
    is_manual: spec.is_manual ? 1 : 0,
    status: spec.status ?? 'posted',
    data: JSON.stringify(spec.data ?? {}),
    created_by: spec.created_by ?? null,
  });
  for (const l of lines) {
    d.insert('journal_lines', {
      journal_id: id, account_id: l.account_id, debit: l.debit, credit: l.credit,
      contact_id: l.contact_id ?? null, item_id: l.item_id ?? null, description: l.description ?? null,
    });
  }
  return id;
}

/**
 * Replaces all journals of a source with a fresh one (or removes them when spec is null).
 * Bank reconciliation marks are carried over per account so re-posting never un-reconciles a bank line, and any bank
 * statement line matched to the source is released if the new posting no longer matches it.
 */
export function replaceJournal(sourceType: string, sourceId: number, spec: Omit<JournalSpec, 'source_type' | 'source_id'> | null) {
  const d = db();
  const recon = new Map<number, number>();
  for (const r of d.all<{ account_id: number; recon_id: number }>(
    `SELECT jl.account_id, jl.recon_id FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
     WHERE j.source_type = ? AND j.source_id = ? AND jl.recon_id IS NOT NULL`, sourceType, sourceId)) recon.set(r.account_id, r.recon_id);
  d.run('DELETE FROM journals WHERE source_type = ? AND source_id = ?', sourceType, sourceId);
  const id = spec ? postJournal({ ...spec, source_type: sourceType, source_id: sourceId }) : null;
  if (id && recon.size) {
    for (const [account, rid] of recon) d.run('UPDATE journal_lines SET recon_id = ? WHERE journal_id = ? AND account_id = ?', rid, id, account);
  }
  syncBankMatches(sourceType, sourceId);
  return id;
}

/**
 * A bank statement line stays matched to a transaction only while that transaction still posts the same amount, in the
 * same direction, to the statement's account. Lines whose transaction was deleted, voided, drafted or changed are released.
 */
export function syncBankMatches(sourceType: string, sourceId: number) {
  const d = db();
  for (const l of d.all<Row>('SELECT * FROM bank_statement_lines WHERE matched_source_type = ? AND matched_source_id = ?', sourceType, sourceId)) {
    const posted = d.value<number>(
      `SELECT COALESCE(SUM(${l.deposit > 0 ? 'jl.debit' : 'jl.credit'}), 0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
       WHERE j.source_type = ? AND j.source_id = ? AND j.status = 'posted' AND jl.account_id = ?`, sourceType, sourceId, l.account_id) ?? 0;
    if (Math.abs(posted - (l.deposit || l.withdrawal)) > 0.005) releaseBankMatch(l.id);
  }
}

export function releaseBankMatch(statementLineId: number) {
  db().run(`UPDATE bank_statement_lines SET status = 'uncategorized', matched_source_type = NULL, matched_source_id = NULL WHERE id = ?`, statementLineId);
}

export function assertNotReconciled(sourceType: string, sourceId: number, action = 'change') {
  const hit = db().get(
    `SELECT 1 FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE j.source_type = ? AND j.source_id = ? AND jl.recon_id IS NOT NULL`,
    sourceType, sourceId);
  if (hit) fail(`This transaction is part of a completed bank reconciliation. Undo the reconciliation before you ${action} it.`, 422);
}

export function journalsFor(sourceType: string, sourceId: number) {
  return db().all(
    `SELECT j.id, j.date, j.memo, jl.account_id, a.name AS account_name, a.code AS account_code, jl.debit, jl.credit, jl.description
     FROM journals j JOIN journal_lines jl ON jl.journal_id = j.id JOIN accounts a ON a.id = jl.account_id
     WHERE j.source_type = ? AND j.source_id = ? ORDER BY j.id, jl.debit DESC, jl.id`, sourceType, sourceId);
}

/** Natural-sign balance (debit-nature accounts positive when debit > credit). */
export function accountBalance(accountId: number, toDate?: string, fromDate?: string): number {
  const a = db().get<{ type: string }>('SELECT type FROM accounts WHERE id = ?', accountId);
  if (!a) return 0;
  const raw = db().value<number>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
     WHERE jl.account_id = ? AND j.status = 'posted' AND (? IS NULL OR j.date <= ?) AND (? IS NULL OR j.date >= ?)`,
    accountId, toDate ?? null, toDate ?? null, fromDate ?? null, fromDate ?? null) ?? 0;
  return r2(isDebitNature(a.type) ? raw : -raw);
}

export function seedAccounts() {
  const d = db();
  for (const [code, name, type, key] of DEFAULT_ACCOUNTS) {
    if (!d.get('SELECT 1 FROM accounts WHERE code = ? OR (system_key IS NOT NULL AND system_key = ?)', code, key)) {
      d.insert('accounts', { code, name, type, system_key: key });
    }
  }
}
