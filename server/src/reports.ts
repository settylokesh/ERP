import { db, fail, json, type Row } from './db.js';
import { availableBatches, availableSerials, committedQty, stockSummary } from './inventory.js';
import { ACCOUNT_TYPES, acct, categoryOf } from './ledger.js';
import { org } from './settings.js';
import { addDays, daysBetween, fiscalYear, r2, today } from './util.js';

export interface Column { key: string; label: string; type?: 'text' | 'money' | 'number' | 'date' | 'percent'; link?: string }
export interface ReportResult { title: string; subtitle?: string; columns: Column[]; rows: Row[]; totals?: Row; sections?: { title: string; rows: Row[]; total?: number }[]; meta?: Row }
type ReportFn = (q: Row) => ReportResult;

const period = (q: Row) => {
  const fy = fiscalYear(today(), org().fiscal_year_start_month);
  return { from: q.from || fy.start, to: q.to || today() };
};
const sumBy = (rows: Row[], k: string) => r2(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0));
const money = (key: string, label: string): Column => ({ key, label, type: 'money' });

/** Net movement per account in a date range (natural sign by category). */
function accountMovements(from: string | null, to: string) {
  return db().all<Row>(
    `SELECT a.id, a.code, a.name, a.type, a.parent_id, COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
     FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id
       AND jl.journal_id IN (SELECT id FROM journals WHERE status = 'posted' AND date <= ? AND (? IS NULL OR date >= ?))
     GROUP BY a.id ORDER BY a.code`, to, from, from).map((a) => {
    const cat = categoryOf(a.type);
    const natural = ['asset', 'expense'].includes(cat) ? a.debit - a.credit : a.credit - a.debit;
    return { ...a, category: cat, debit: r2(a.debit), credit: r2(a.credit), balance: r2(natural) };
  });
}

function profitAndLossData(from: string, to: string) {
  const rows = accountMovements(from, to).filter((a) => ['income', 'expense'].includes(a.category) && Math.abs(a.balance) > 0.004);
  const g = (types: string[]) => rows.filter((r) => types.includes(r.type));
  const operatingIncome = g(['income']), cogs = g(['cost_of_goods_sold']), opex = g(['expense']), otherIncome = g(['other_income']), otherExpense = g(['other_expense']);
  const t = (rs: Row[]) => sumBy(rs, 'balance');
  const gross = r2(t(operatingIncome) - t(cogs));
  const operating = r2(gross - t(opex));
  const net = r2(operating + t(otherIncome) - t(otherExpense));
  return { operatingIncome, cogs, opex, otherIncome, otherExpense, gross, operating, net, t };
}

export function netProfit(from: string | null, to: string): number {
  const rows = accountMovements(from, to).filter((a) => ['income', 'expense'].includes(a.category));
  return r2(rows.reduce((s, r) => s + (r.category === 'income' ? r.balance : -r.balance), 0));
}

const AGE_BUCKETS = [
  { key: 'current', label: 'Current', min: -Infinity, max: 0 },
  { key: 'd1_15', label: '1 - 15 Days', min: 1, max: 15 },
  { key: 'd16_30', label: '16 - 30 Days', min: 16, max: 30 },
  { key: 'd31_45', label: '31 - 45 Days', min: 31, max: 45 },
  { key: 'd45', label: '> 45 Days', min: 46, max: Infinity },
];
function aging(type: 'invoice' | 'bill', asOf: string, detail: boolean): ReportResult {
  const docs = db().all<Row>(
    `SELECT d.id, d.number, d.date, d.due_date, d.balance, d.total, d.contact_id, c.name AS contact_name, d.status FROM documents d JOIN contacts c ON c.id = d.contact_id
     WHERE d.type = ? AND d.status IN ('open','partially_paid') AND d.date <= ? ORDER BY c.name, d.due_date`, type, asOf);
  const bucketOf = (due: string) => {
    const days = daysBetween(due || asOf, asOf);
    return AGE_BUCKETS.find((b) => days >= b.min && days <= b.max)!.key;
  };
  if (detail) {
    const rows = docs.map((d) => ({ ...d, age: Math.max(0, daysBetween(d.due_date || d.date, asOf)), bucket: AGE_BUCKETS.find((b) => b.key === bucketOf(d.due_date))!.label }));
    return {
      title: type === 'invoice' ? 'AR Aging Details' : 'AP Aging Details', subtitle: `As of ${asOf}`,
      columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'number', label: type === 'invoice' ? 'Invoice#' : 'Bill#', link: `docs/${type}` }, { key: 'contact_name', label: type === 'invoice' ? 'Customer' : 'Vendor' }, { key: 'due_date', label: 'Due Date', type: 'date' }, { key: 'age', label: 'Age (days)', type: 'number' }, { key: 'bucket', label: 'Bucket' }, money('total', 'Amount'), money('balance', 'Balance Due')],
      rows, totals: { total: sumBy(rows, 'total'), balance: sumBy(rows, 'balance') },
    };
  }
  const by = new Map<number, Row>();
  for (const d of docs) {
    const r = by.get(d.contact_id) ?? { contact_id: d.contact_id, contact_name: d.contact_name, current: 0, d1_15: 0, d16_30: 0, d31_45: 0, d45: 0, total: 0 };
    const b = bucketOf(d.due_date);
    r[b] = r2(r[b] + d.balance);
    r.total = r2(r.total + d.balance);
    by.set(d.contact_id, r);
  }
  const rows = [...by.values()];
  return {
    title: type === 'invoice' ? 'AR Aging Summary' : 'AP Aging Summary', subtitle: `As of ${asOf} (by due date)`,
    columns: [{ key: 'contact_name', label: type === 'invoice' ? 'Customer' : 'Vendor', link: type === 'invoice' ? 'customers' : 'vendors' }, ...AGE_BUCKETS.map((b) => money(b.key, b.label)), money('total', 'Total')],
    rows, totals: Object.fromEntries(['current', 'd1_15', 'd16_30', 'd31_45', 'd45', 'total'].map((k) => [k, sumBy(rows, k)])),
  };
}

function salesBy(groupBy: 'customer' | 'item' | 'salesperson', q: Row): ReportResult {
  const { from, to } = period(q);
  const key = groupBy === 'customer' ? 'c.name' : groupBy === 'item' ? "COALESCE(i.name, l.description)" : "COALESCE(d.salesperson, 'Unassigned')";
  const rows = db().all<Row>(
    `SELECT ${key} AS name, ${groupBy === 'item' ? 'l.item_id' : groupBy === 'customer' ? 'd.contact_id' : 'NULL'} AS ref_id,
       SUM(CASE WHEN d.type = 'invoice' THEN l.qty ELSE -l.qty END) AS qty,
       SUM(CASE WHEN d.type = 'invoice' THEN l.taxable ELSE -l.taxable END * d.exchange_rate) AS sales,
       SUM(CASE WHEN d.type = 'invoice' THEN l.taxable + l.cgst + l.sgst + l.igst ELSE -(l.taxable + l.cgst + l.sgst + l.igst) END * d.exchange_rate) AS sales_with_tax,
       COUNT(DISTINCT d.id) AS documents
     FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN contacts c ON c.id = d.contact_id LEFT JOIN items i ON i.id = l.item_id
     WHERE d.type IN ('invoice','credit_note') AND d.status IN ('open','partially_paid','paid','closed') AND d.date BETWEEN ? AND ?
     GROUP BY ${key} ORDER BY sales DESC`, from, to).map((r) => ({ ...r, qty: r2(r.qty), sales: r2(r.sales), sales_with_tax: r2(r.sales_with_tax), avg_price: r.qty ? r2(r.sales / r.qty) : 0 }));
  if (groupBy === 'item') {
    for (const r of rows) {
      const cogs = r.ref_id ? -(db().value<number>(
        `SELECT COALESCE(SUM(m.value),0) FROM stock_moves m JOIN documents d ON d.id = m.source_id AND d.type = m.source_type
         WHERE m.item_id = ? AND m.accounting = 1 AND m.source_type IN ('invoice','credit_note') AND d.date BETWEEN ? AND ?`, r.ref_id, from, to) ?? 0) : 0;
      r.cogs = r2(cogs);
      r.margin = r2(r.sales - cogs);
      r.margin_pct = r.sales ? r2((r.margin / r.sales) * 100) : 0;
    }
  }
  const label = groupBy === 'customer' ? 'Customer' : groupBy === 'item' ? 'Item' : 'Salesperson';
  const cols: Column[] = [{ key: 'name', label }, { key: 'documents', label: 'Invoices', type: 'number' }, { key: 'qty', label: 'Quantity Sold', type: 'number' }, money('sales', 'Sales'), money('sales_with_tax', 'Sales With Tax')];
  if (groupBy === 'item') cols.push({ key: 'avg_price', label: 'Average Price', type: 'money' }, money('cogs', 'COGS'), money('margin', 'Gross Margin'), { key: 'margin_pct', label: 'Margin %', type: 'percent' });
  return { title: `Sales by ${label}`, subtitle: `${from} to ${to}`, columns: cols, rows, totals: { sales: sumBy(rows, 'sales'), sales_with_tax: sumBy(rows, 'sales_with_tax'), qty: sumBy(rows, 'qty'), cogs: sumBy(rows, 'cogs'), margin: sumBy(rows, 'margin') } };
}

function purchasesBy(groupBy: 'vendor' | 'item', q: Row): ReportResult {
  const { from, to } = period(q);
  const key = groupBy === 'vendor' ? 'c.name' : 'COALESCE(i.name, a.name, l.description)';
  const rows = db().all<Row>(
    `SELECT ${key} AS name, SUM(CASE WHEN d.type = 'bill' THEN l.qty ELSE -l.qty END) AS qty,
       SUM(CASE WHEN d.type = 'bill' THEN l.taxable ELSE -l.taxable END * d.exchange_rate) AS amount,
       SUM(CASE WHEN d.type = 'bill' THEN l.taxable + l.cgst + l.sgst + l.igst ELSE -(l.taxable + l.cgst + l.sgst + l.igst) END * d.exchange_rate) AS amount_with_tax
     FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN contacts c ON c.id = d.contact_id LEFT JOIN items i ON i.id = l.item_id LEFT JOIN accounts a ON a.id = l.account_id
     WHERE d.type IN ('bill','vendor_credit') AND d.status IN ('open','partially_paid','paid','closed') AND d.date BETWEEN ? AND ?
     GROUP BY ${key} ORDER BY amount DESC`, from, to).map((r) => ({ ...r, qty: r2(r.qty), amount: r2(r.amount), amount_with_tax: r2(r.amount_with_tax), avg_price: r.qty ? r2(r.amount / r.qty) : 0 }));
  return {
    title: `Purchases by ${groupBy === 'vendor' ? 'Vendor' : 'Item'}`, subtitle: `${from} to ${to}`,
    columns: [{ key: 'name', label: groupBy === 'vendor' ? 'Vendor' : 'Item' }, { key: 'qty', label: 'Quantity', type: 'number' }, money('amount', 'Amount'), money('amount_with_tax', 'Amount With Tax'), money('avg_price', 'Average Price')],
    rows, totals: { amount: sumBy(rows, 'amount'), amount_with_tax: sumBy(rows, 'amount_with_tax') },
  };
}

function payrollStat(q: Row, title: string, codes: { field: 'deductions' | 'employer'; code: string; label: string }[]): ReportResult {
  const { from, to } = period(q);
  const slips = db().all<Row>(
    `SELECT p.*, e.name, e.emp_code, e.uan, e.esi_number, e.work_state, r.period FROM payslips p JOIN pay_runs r ON r.id = p.pay_run_id JOIN employees e ON e.id = p.employee_id
     WHERE r.status IN ('approved','paid') AND r.period BETWEEN ? AND ? ORDER BY r.period, e.emp_code`, from.slice(0, 7), to.slice(0, 7));
  const rows = slips.map((s) => {
    const row: Row = { period: s.period, emp_code: s.emp_code, name: s.name, uan: s.uan, esi_number: s.esi_number, gross: s.gross };
    for (const c of codes) row[c.code] = json<Row[]>(s[c.field], []).find((x) => x.code === c.code)?.amount ?? 0;
    return row;
  }).filter((r) => codes.some((c) => r[c.code]));
  return {
    title, subtitle: `${from.slice(0, 7)} to ${to.slice(0, 7)}`,
    columns: [{ key: 'period', label: 'Period' }, { key: 'emp_code', label: 'Emp ID' }, { key: 'name', label: 'Employee' }, { key: 'uan', label: 'UAN / IP' }, money('gross', 'Gross Wages'), ...codes.map((c) => money(c.code, c.label))],
    rows, totals: Object.fromEntries(['gross', ...codes.map((c) => c.code)].map((k) => [k, sumBy(rows, k)])),
  };
}

export const REPORTS: Record<string, { category: string; title: string; fn: ReportFn; params?: string[] }> = {
  profit_and_loss: {
    category: 'Business Overview', title: 'Profit and Loss', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const p = profitAndLossData(from, to);
      const sec = (title: string, rows: Row[]) => ({ title, rows: rows.map((r) => ({ account_id: r.id, account: r.name, code: r.code, amount: r.balance })), total: p.t(rows) });
      return {
        title: 'Profit and Loss', subtitle: `${from} to ${to}`,
        columns: [{ key: 'account', label: 'Account' }, money('amount', 'Total')],
        rows: [],
        sections: [
          sec('Operating Income', p.operatingIncome), sec('Cost of Goods Sold', p.cogs), { title: 'Gross Profit', rows: [], total: p.gross },
          sec('Operating Expense', p.opex), { title: 'Operating Profit', rows: [], total: p.operating },
          sec('Non Operating Income', p.otherIncome), sec('Non Operating Expense', p.otherExpense), { title: 'Net Profit/Loss', rows: [], total: p.net },
        ],
        meta: { gross_profit: p.gross, operating_profit: p.operating, net_profit: p.net },
      };
    },
  },
  balance_sheet: {
    category: 'Business Overview', title: 'Balance Sheet', params: ['to'],
    fn: (q) => {
      const asOf = q.to || today();
      const fy = fiscalYear(asOf, org().fiscal_year_start_month);
      const acc = accountMovements(null, asOf).filter((a) => ['asset', 'liability', 'equity'].includes(a.category) && Math.abs(a.balance) > 0.004);
      const group = (types: string[]) => acc.filter((a) => types.includes(a.type)).map((a) => ({ account_id: a.id, account: a.name, code: a.code, amount: a.balance }));
      const currentEarnings = netProfit(fy.start, asOf);
      const retained = r2(netProfit(null, addDays(fy.start, -1)));
      const equity = [...group(['equity']), { account: 'Retained Earnings (accumulated)', amount: retained }, { account: 'Current Year Earnings', amount: currentEarnings }];
      const secs = [
        { title: 'Current Assets', rows: group(['cash', 'bank', 'accounts_receivable', 'other_current_asset', 'stock']) },
        { title: 'Fixed Assets', rows: group(['fixed_asset']) },
        { title: 'Other Assets', rows: group(['other_asset']) },
        { title: 'Current Liabilities', rows: group(['accounts_payable', 'credit_card', 'other_current_liability']) },
        { title: 'Long Term Liabilities', rows: group(['long_term_liability']) },
        { title: 'Other Liabilities', rows: group(['other_liability']) },
        { title: 'Equities', rows: equity },
      ].map((s) => ({ ...s, total: sumBy(s.rows, 'amount') }));
      const assets = r2(secs.slice(0, 3).reduce((a, s) => a + s.total, 0));
      const liabilities = r2(secs.slice(3, 6).reduce((a, s) => a + s.total, 0));
      const eq = secs[6].total;
      return {
        title: 'Balance Sheet', subtitle: `As of ${asOf}`, columns: [{ key: 'account', label: 'Account' }, money('amount', 'Total')], rows: [], sections: secs,
        meta: { total_assets: assets, total_liabilities: liabilities, total_equity: eq, liabilities_and_equity: r2(liabilities + eq), balanced: Math.abs(assets - (liabilities + eq)) < 0.01 },
      };
    },
  },
  cash_flow: {
    category: 'Business Overview', title: 'Cash Flow Statement', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const d = db();
      const cashTypes = ['cash', 'bank'];
      const journals = d.all<Row>(
        `SELECT DISTINCT j.id FROM journals j JOIN journal_lines jl ON jl.journal_id = j.id JOIN accounts a ON a.id = jl.account_id
         WHERE j.status = 'posted' AND j.date BETWEEN ? AND ? AND a.type IN ('cash','bank')`, from, to);
      const buckets: Record<string, Map<string, number>> = { Operating: new Map(), Investing: new Map(), Financing: new Map() };
      const classify = (type: string) => (type === 'fixed_asset' || type === 'other_asset' ? 'Investing' : type === 'equity' || type === 'long_term_liability' ? 'Financing' : 'Operating');
      for (const { id } of journals) {
        const lines = d.all<Row>('SELECT jl.*, a.type, a.name FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.journal_id = ?', id);
        const cashDelta = lines.filter((l) => cashTypes.includes(l.type)).reduce((a, l) => a + l.debit - l.credit, 0);
        const others = lines.filter((l) => !cashTypes.includes(l.type));
        const totalOther = others.reduce((a, l) => a + Math.abs(l.debit - l.credit), 0);
        if (!others.length || !totalOther) continue;
        for (const l of others) {
          const share = cashDelta * Math.abs(l.debit - l.credit) / totalOther;
          const label = ['income', 'other_income'].includes(l.type) ? 'Receipts from income' : l.type === 'accounts_receivable' ? 'Collections from customers'
            : l.type === 'accounts_payable' ? 'Payments to vendors' : ['expense', 'cost_of_goods_sold', 'other_expense'].includes(l.type) ? 'Payments for expenses'
            : l.type === 'other_current_liability' ? 'Taxes, payroll and other liabilities' : l.name;
          const b = buckets[classify(l.type)];
          b.set(label, r2((b.get(label) ?? 0) + share));
        }
      }
      const opening = r2(d.value<number>(`SELECT COALESCE(SUM(jl.debit - jl.credit),0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id WHERE a.type IN ('cash','bank') AND j.status = 'posted' AND j.date < ?`, from) ?? 0);
      const sections = Object.entries(buckets).map(([k, m]) => {
        const rows = [...m.entries()].map(([account, amount]) => ({ account, amount: r2(amount) }));
        return { title: `Cash Flow from ${k} Activities`, rows, total: sumBy(rows, 'amount') };
      });
      const net = r2(sections.reduce((a, s) => a + s.total, 0));
      sections.push({ title: 'Net Change in Cash', rows: [{ account: 'Beginning Cash Balance', amount: opening }, { account: 'Ending Cash Balance', amount: r2(opening + net) }], total: net });
      return { title: 'Cash Flow Statement', subtitle: `${from} to ${to}`, columns: [{ key: 'account', label: 'Activity' }, money('amount', 'Total')], rows: [], sections, meta: { opening, closing: r2(opening + net), net } };
    },
  },
  business_performance: {
    category: 'Business Overview', title: 'Business Performance Ratios', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const p = profitAndLossData(from, to);
      const acc = accountMovements(null, to);
      const bal = (types: string[]) => r2(acc.filter((a) => types.includes(a.type)).reduce((s, a) => s + a.balance, 0));
      const ca = bal(['cash', 'bank', 'accounts_receivable', 'other_current_asset', 'stock']);
      const cl = bal(['accounts_payable', 'credit_card', 'other_current_liability']);
      const inv = bal(['stock']);
      const ar = bal(['accounts_receivable']), ap = bal(['accounts_payable']);
      const revenue = p.t(p.operatingIncome);
      const cogs = p.t(p.cogs);
      const days = Math.max(1, daysBetween(from, to) + 1);
      const equity = r2(bal(['equity']) + netProfit(null, to));
      const debt = bal(['long_term_liability', 'other_liability', 'credit_card', 'other_current_liability', 'accounts_payable']);
      const ratio = (a: number, b: number, pct = false) => (b ? r2((a / b) * (pct ? 100 : 1)) : null);
      const rows = [
        { ratio: 'Current Ratio', value: ratio(ca, cl), note: 'Current assets / current liabilities' },
        { ratio: 'Quick Ratio', value: ratio(ca - inv, cl), note: '(Current assets - inventory) / current liabilities' },
        { ratio: 'Gross Profit Margin %', value: ratio(p.gross, revenue, true), note: 'Gross profit / operating income' },
        { ratio: 'Net Profit Margin %', value: ratio(p.net, revenue, true), note: 'Net profit / operating income' },
        { ratio: 'Debt to Equity', value: ratio(debt, equity), note: 'Total liabilities / equity' },
        { ratio: 'Days Sales Outstanding', value: revenue ? r2((ar / revenue) * days) : null, note: 'Receivables / revenue × days' },
        { ratio: 'Days Payable Outstanding', value: cogs ? r2((ap / cogs) * days) : null, note: 'Payables / COGS × days' },
        { ratio: 'Inventory Turnover', value: ratio(cogs, inv), note: 'COGS / closing inventory' },
      ];
      return { title: 'Business Performance Ratios', subtitle: `${from} to ${to}`, columns: [{ key: 'ratio', label: 'Ratio' }, { key: 'value', label: 'Value', type: 'number' }, { key: 'note', label: 'Formula' }], rows };
    },
  },
  trial_balance: {
    category: 'Accountant', title: 'Trial Balance', params: ['to'],
    fn: (q) => {
      const asOf = q.to || today();
      const rows = accountMovements(null, asOf).map((a) => {
        const net = r2(a.debit - a.credit);
        return { account_id: a.id, code: a.code, account: a.name, type: ACCOUNT_TYPES[a.type]?.label, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
      }).filter((r) => r.debit || r.credit);
      const totals = { debit: sumBy(rows, 'debit'), credit: sumBy(rows, 'credit') };
      return { title: 'Trial Balance', subtitle: `As of ${asOf}`, columns: [{ key: 'code', label: 'Code' }, { key: 'account', label: 'Account', link: 'accounts' }, { key: 'type', label: 'Account Type' }, money('debit', 'Net Debit'), money('credit', 'Net Credit')], rows, totals, meta: { balanced: Math.abs(totals.debit - totals.credit) < 0.01 } };
    },
  },
  general_ledger: {
    category: 'Accountant', title: 'General Ledger', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const open = new Map(accountMovements(null, addDays(from, -1)).map((a) => [a.id, a]));
      const rows = accountMovements(from, to).filter((a) => a.debit || a.credit || open.get(a.id)?.balance).map((a) => {
        const o = open.get(a.id)!;
        const debitNature = ['asset', 'expense'].includes(a.category);
        const opening = o?.balance ?? 0;
        const closing = r2(opening + (debitNature ? a.debit - a.credit : a.credit - a.debit));
        return { account_id: a.id, code: a.code, account: a.name, opening, debit: a.debit, credit: a.credit, closing };
      });
      return { title: 'General Ledger', subtitle: `${from} to ${to}`, columns: [{ key: 'code', label: 'Code' }, { key: 'account', label: 'Account', link: 'accounts' }, money('opening', 'Opening Balance'), money('debit', 'Debit'), money('credit', 'Credit'), money('closing', 'Closing Balance')], rows, totals: { debit: sumBy(rows, 'debit'), credit: sumBy(rows, 'credit') } };
    },
  },
  journal_report: {
    category: 'Accountant', title: 'Journal Report (Day Book)', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(
        `SELECT j.date, j.source_type, j.source_id, COALESCE(j.number, j.reference) AS reference, j.memo, a.name AS account, c.name AS contact, jl.debit, jl.credit
         FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id LEFT JOIN contacts c ON c.id = jl.contact_id
         WHERE j.status = 'posted' AND j.date BETWEEN ? AND ? ORDER BY j.date, j.id, jl.debit DESC, jl.id LIMIT 5000`, from, to);
      return { title: 'Journal Report', subtitle: `${from} to ${to}`, columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Reference' }, { key: 'memo', label: 'Transaction' }, { key: 'account', label: 'Account' }, { key: 'contact', label: 'Contact' }, money('debit', 'Debit'), money('credit', 'Credit')], rows, totals: { debit: sumBy(rows, 'debit'), credit: sumBy(rows, 'credit') } };
    },
  },
  sales_by_customer: { category: 'Sales', title: 'Sales by Customer', params: ['from', 'to'], fn: (q) => salesBy('customer', q) },
  sales_by_item: { category: 'Sales', title: 'Sales by Item', params: ['from', 'to'], fn: (q) => salesBy('item', q) },
  sales_by_salesperson: { category: 'Sales', title: 'Sales by Salesperson', params: ['from', 'to'], fn: (q) => salesBy('salesperson', q) },
  sales_order_details: {
    category: 'Sales', title: 'Sales Order Details', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(`SELECT d.id, d.number, d.date, c.name AS customer, d.status, d.fulfil_status, d.billing_status, d.total FROM documents d JOIN contacts c ON c.id = d.contact_id WHERE d.type = 'sales_order' AND d.date BETWEEN ? AND ? ORDER BY d.date DESC`, from, to);
      return { title: 'Sales Order Details', subtitle: `${from} to ${to}`, columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'number', label: 'Sales Order#', link: 'docs/sales_order' }, { key: 'customer', label: 'Customer' }, { key: 'status', label: 'Status' }, { key: 'fulfil_status', label: 'Shipment' }, { key: 'billing_status', label: 'Invoiced' }, money('total', 'Amount')], rows, totals: { total: sumBy(rows, 'total') } };
    },
  },
  ar_aging_summary: { category: 'Receivables', title: 'AR Aging Summary', params: ['to'], fn: (q) => aging('invoice', q.to || today(), false) },
  ar_aging_details: { category: 'Receivables', title: 'AR Aging Details', params: ['to'], fn: (q) => aging('invoice', q.to || today(), true) },
  customer_balances: {
    category: 'Receivables', title: 'Customer Balance Summary', params: ['to'],
    fn: (q) => {
      const asOf = q.to || today();
      const ar = acct('accounts_receivable');
      const rows = db().all<Row>(
        `SELECT c.id AS contact_id, c.name AS customer,
           COALESCE((SELECT SUM(total) FROM documents WHERE contact_id = c.id AND type = 'invoice' AND status IN ('open','partially_paid','paid') AND date <= ?),0) AS invoiced,
           COALESCE((SELECT SUM(amount) FROM payments WHERE contact_id = c.id AND kind = 'received' AND status <> 'void' AND date <= ?),0) AS received,
           COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE jl.contact_id = c.id AND jl.account_id = ? AND j.date <= ?),0) AS balance
         FROM contacts c WHERE c.kind = 'customer' ORDER BY c.name`, asOf, asOf, ar, asOf).map((r) => ({ ...r, invoiced: r2(r.invoiced), received: r2(r.received), balance: r2(r.balance) })).filter((r) => r.invoiced || r.balance);
      return { title: 'Customer Balance Summary', subtitle: `As of ${asOf}`, columns: [{ key: 'customer', label: 'Customer', link: 'customers' }, money('invoiced', 'Invoiced Amount'), money('received', 'Amount Received'), money('balance', 'Closing Balance')], rows, totals: { invoiced: sumBy(rows, 'invoiced'), received: sumBy(rows, 'received'), balance: sumBy(rows, 'balance') } };
    },
  },
  invoice_details: {
    category: 'Receivables', title: 'Invoice Details', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(`SELECT d.id, d.number, d.date, d.due_date, c.name AS customer, d.status, d.taxable_total, d.tax_total, d.total, d.balance FROM documents d JOIN contacts c ON c.id = d.contact_id WHERE d.type = 'invoice' AND d.status <> 'draft' AND d.date BETWEEN ? AND ? ORDER BY d.date DESC`, from, to);
      return { title: 'Invoice Details', subtitle: `${from} to ${to}`, columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'number', label: 'Invoice#', link: 'docs/invoice' }, { key: 'customer', label: 'Customer' }, { key: 'status', label: 'Status' }, { key: 'due_date', label: 'Due Date', type: 'date' }, money('taxable_total', 'Taxable'), money('tax_total', 'GST'), money('total', 'Total'), money('balance', 'Balance')], rows, totals: { taxable_total: sumBy(rows, 'taxable_total'), tax_total: sumBy(rows, 'tax_total'), total: sumBy(rows, 'total'), balance: sumBy(rows, 'balance') } };
    },
  },
  payments_received: {
    category: 'Receivables', title: 'Payments Received', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(`SELECT p.id, p.number, p.date, c.name AS customer, p.mode, a.name AS deposit_to, p.reference, p.amount FROM payments p JOIN contacts c ON c.id = p.contact_id JOIN accounts a ON a.id = p.account_id WHERE p.kind = 'received' AND p.date BETWEEN ? AND ? ORDER BY p.date DESC`, from, to);
      return { title: 'Payments Received', subtitle: `${from} to ${to}`, columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'number', label: 'Payment#' }, { key: 'customer', label: 'Customer' }, { key: 'mode', label: 'Mode' }, { key: 'deposit_to', label: 'Deposit To' }, { key: 'reference', label: 'Reference' }, money('amount', 'Amount')], rows, totals: { amount: sumBy(rows, 'amount') } };
    },
  },
  ap_aging_summary: { category: 'Payables', title: 'AP Aging Summary', params: ['to'], fn: (q) => aging('bill', q.to || today(), false) },
  ap_aging_details: { category: 'Payables', title: 'AP Aging Details', params: ['to'], fn: (q) => aging('bill', q.to || today(), true) },
  vendor_balances: {
    category: 'Payables', title: 'Vendor Balance Summary', params: ['to'],
    fn: (q) => {
      const asOf = q.to || today();
      const ap = acct('accounts_payable');
      const rows = db().all<Row>(
        `SELECT c.id AS contact_id, c.name AS vendor,
           COALESCE((SELECT SUM(total) FROM documents WHERE contact_id = c.id AND type = 'bill' AND status IN ('open','partially_paid','paid') AND date <= ?),0) AS billed,
           COALESCE((SELECT SUM(amount) FROM payments WHERE contact_id = c.id AND kind = 'made' AND status <> 'void' AND date <= ?),0) AS paid,
           COALESCE((SELECT SUM(jl.credit - jl.debit) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE jl.contact_id = c.id AND jl.account_id = ? AND j.date <= ?),0) AS balance
         FROM contacts c WHERE c.kind = 'vendor' ORDER BY c.name`, asOf, asOf, ap, asOf).map((r) => ({ ...r, billed: r2(r.billed), paid: r2(r.paid), balance: r2(r.balance) })).filter((r) => r.billed || r.balance);
      return { title: 'Vendor Balance Summary', subtitle: `As of ${asOf}`, columns: [{ key: 'vendor', label: 'Vendor', link: 'vendors' }, money('billed', 'Billed Amount'), money('paid', 'Amount Paid'), money('balance', 'Closing Balance')], rows, totals: { billed: sumBy(rows, 'billed'), paid: sumBy(rows, 'paid'), balance: sumBy(rows, 'balance') } };
    },
  },
  bill_details: {
    category: 'Payables', title: 'Bill Details', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(`SELECT d.id, d.number, d.reference, d.date, d.due_date, c.name AS vendor, d.status, d.total, d.tds_amount, d.balance FROM documents d JOIN contacts c ON c.id = d.contact_id WHERE d.type = 'bill' AND d.status <> 'draft' AND d.date BETWEEN ? AND ? ORDER BY d.date DESC`, from, to);
      return { title: 'Bill Details', subtitle: `${from} to ${to}`, columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'number', label: 'Bill#', link: 'docs/bill' }, { key: 'reference', label: 'Vendor Ref' }, { key: 'vendor', label: 'Vendor' }, { key: 'status', label: 'Status' }, { key: 'due_date', label: 'Due Date', type: 'date' }, money('tds_amount', 'TDS'), money('total', 'Total'), money('balance', 'Balance')], rows, totals: { total: sumBy(rows, 'total'), balance: sumBy(rows, 'balance'), tds_amount: sumBy(rows, 'tds_amount') } };
    },
  },
  purchases_by_vendor: { category: 'Payables', title: 'Purchases by Vendor', params: ['from', 'to'], fn: (q) => purchasesBy('vendor', q) },
  purchases_by_item: { category: 'Payables', title: 'Purchases by Item', params: ['from', 'to'], fn: (q) => purchasesBy('item', q) },
  purchase_order_details: {
    category: 'Payables', title: 'Purchase Order Details', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(`SELECT d.id, d.number, d.date, c.name AS vendor, d.status, d.fulfil_status, d.billing_status, d.total FROM documents d JOIN contacts c ON c.id = d.contact_id WHERE d.type = 'purchase_order' AND d.date BETWEEN ? AND ? ORDER BY d.date DESC`, from, to);
      return { title: 'Purchase Order Details', subtitle: `${from} to ${to}`, columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'number', label: 'PO#', link: 'docs/purchase_order' }, { key: 'vendor', label: 'Vendor' }, { key: 'status', label: 'Status' }, { key: 'fulfil_status', label: 'Received' }, { key: 'billing_status', label: 'Billed' }, money('total', 'Amount')], rows, totals: { total: sumBy(rows, 'total') } };
    },
  },
  stock_summary: {
    category: 'Inventory', title: 'Stock Summary', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(
        `SELECT i.id AS item_id, i.name, i.sku, i.unit,
           COALESCE((SELECT SUM(qty) FROM stock_moves WHERE item_id = i.id AND physical = 1 AND date < ?),0) AS opening,
           COALESCE((SELECT SUM(qty) FROM stock_moves WHERE item_id = i.id AND physical = 1 AND qty > 0 AND kind <> 'transfer' AND date BETWEEN ? AND ?),0) AS qty_in,
           COALESCE((SELECT -SUM(qty) FROM stock_moves WHERE item_id = i.id AND physical = 1 AND qty < 0 AND kind <> 'transfer' AND date BETWEEN ? AND ?),0) AS qty_out
         FROM items i WHERE i.type = 'goods' AND i.track_inventory = 1 ORDER BY i.name`, from, from, to, from, to)
        .map((r) => ({ ...r, opening: r2(r.opening), qty_in: r2(r.qty_in), qty_out: r2(r.qty_out), closing: r2(r.opening + r.qty_in - r.qty_out) }));
      return { title: 'Stock Summary', subtitle: `${from} to ${to}`, columns: [{ key: 'name', label: 'Item', link: 'items' }, { key: 'sku', label: 'SKU' }, { key: 'opening', label: 'Opening Stock', type: 'number' }, { key: 'qty_in', label: 'Quantity In', type: 'number' }, { key: 'qty_out', label: 'Quantity Out', type: 'number' }, { key: 'closing', label: 'Closing Stock', type: 'number' }], rows };
    },
  },
  inventory_valuation: {
    category: 'Inventory', title: 'Inventory Valuation Summary', params: ['to'],
    fn: (q) => {
      const asOf = q.to || today();
      const rows = db().all<Row>(
        `SELECT i.id AS item_id, i.name, i.sku, i.unit, COALESCE(SUM(m.qty),0) AS qty, COALESCE(SUM(m.value),0) AS value
         FROM items i LEFT JOIN stock_moves m ON m.item_id = i.id AND m.accounting = 1 AND m.date <= ?
         WHERE i.type = 'goods' AND i.track_inventory = 1 GROUP BY i.id ORDER BY i.name`, asOf)
        .map((r) => ({ ...r, qty: r2(r.qty), value: r2(r.value), unit_cost: r.qty > 0 ? r2(r.value / r.qty) : 0 }));
      const ledger = r2(db().value<number>(
        `SELECT COALESCE(SUM(jl.debit - jl.credit),0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id WHERE a.type = 'stock' AND j.date <= ?`, asOf) ?? 0);
      return {
        title: 'Inventory Valuation Summary', subtitle: `As of ${asOf} (${org().valuation_method.toUpperCase()}, accounting stock)`,
        columns: [{ key: 'name', label: 'Item', link: 'items' }, { key: 'sku', label: 'SKU' }, { key: 'qty', label: 'Stock On Hand', type: 'number' }, money('unit_cost', 'Average Cost'), money('value', 'Inventory Asset Value')],
        rows, totals: { value: sumBy(rows, 'value') }, meta: { ledger_balance: ledger, reconciled: Math.abs(ledger - sumBy(rows, 'value')) < 0.05 },
      };
    },
  },
  fifo_cost_lots: {
    category: 'Inventory', title: 'Inventory Movement & Cost', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(
        `SELECT m.date, i.name AS item, m.kind, w.name AS warehouse, m.qty, m.value, CASE WHEN m.qty <> 0 THEN ROUND(m.value / m.qty, 4) END AS unit_cost,
           COALESCE(d.number, mo.number, 'Opening') AS reference, m.batch_no, m.serial_no
         FROM stock_moves m JOIN items i ON i.id = m.item_id JOIN warehouses w ON w.id = m.warehouse_id
         LEFT JOIN documents d ON d.id = m.source_id AND d.type = m.source_type LEFT JOIN manufacturing_orders mo ON mo.id = m.source_id AND m.source_type = 'mo'
         WHERE m.accounting = 1 AND m.date BETWEEN ? AND ? ORDER BY m.date, m.id LIMIT 5000`, from, to);
      return { title: 'Inventory Movement & Cost', subtitle: `${from} to ${to}`, columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'item', label: 'Item' }, { key: 'reference', label: 'Reference' }, { key: 'kind', label: 'Type' }, { key: 'warehouse', label: 'Warehouse' }, { key: 'batch_no', label: 'Batch' }, { key: 'serial_no', label: 'Serial' }, { key: 'qty', label: 'Quantity', type: 'number' }, money('unit_cost', 'Unit Cost'), money('value', 'Value')], rows };
    },
  },
  warehouse_stock: {
    category: 'Inventory', title: 'Warehouse Stock', params: [],
    fn: () => {
      const rows = db().all<Row>(
        `SELECT i.id AS item_id, i.name AS item, w.name AS warehouse, SUM(CASE WHEN m.physical = 1 THEN m.qty ELSE 0 END) AS physical, SUM(CASE WHEN m.accounting = 1 THEN m.qty ELSE 0 END) AS accounting
         FROM stock_moves m JOIN items i ON i.id = m.item_id JOIN warehouses w ON w.id = m.warehouse_id GROUP BY i.id, w.id HAVING ABS(physical) > 0.0001 OR ABS(accounting) > 0.0001 ORDER BY i.name, w.name`)
        .map((r) => ({ ...r, physical: r2(r.physical), accounting: r2(r.accounting) }));
      return { title: 'Warehouse Stock', columns: [{ key: 'item', label: 'Item', link: 'items' }, { key: 'warehouse', label: 'Warehouse' }, { key: 'physical', label: 'Physical Stock', type: 'number' }, { key: 'accounting', label: 'Accounting Stock', type: 'number' }], rows };
    },
  },
  inventory_aging: {
    category: 'Inventory', title: 'Inventory Aging Summary', params: ['to'],
    fn: (q) => {
      const asOf = q.to || today();
      const items = db().all<Row>("SELECT id, name, sku FROM items WHERE type = 'goods' AND track_inventory = 1 ORDER BY name");
      const rows = items.map((i) => {
        const moves = db().all<Row>('SELECT date, qty FROM stock_moves WHERE item_id = ? AND physical = 1 AND date <= ? ORDER BY date, id', i.id, asOf);
        const layers: { date: string; qty: number }[] = [];
        for (const m of moves) {
          if (m.qty > 0) layers.push({ date: m.date, qty: m.qty });
          else {
            let need = -m.qty;
            while (need > 1e-9 && layers.length) {
              const t = Math.min(need, layers[0].qty);
              layers[0].qty -= t; need -= t;
              if (layers[0].qty <= 1e-9) layers.shift();
            }
          }
        }
        const b = { item_id: i.id, name: i.name, sku: i.sku, d0_30: 0, d31_60: 0, d61_90: 0, d90: 0, total: 0 } as Row;
        for (const l of layers) {
          const age = daysBetween(l.date, asOf);
          const k = age <= 30 ? 'd0_30' : age <= 60 ? 'd31_60' : age <= 90 ? 'd61_90' : 'd90';
          b[k] = r2(b[k] + l.qty);
          b.total = r2(b.total + l.qty);
        }
        return b;
      }).filter((r) => r.total > 0);
      return { title: 'Inventory Aging Summary', subtitle: `As of ${asOf} (FIFO by receipt date)`, columns: [{ key: 'name', label: 'Item', link: 'items' }, { key: 'sku', label: 'SKU' }, { key: 'd0_30', label: '0-30 Days', type: 'number' }, { key: 'd31_60', label: '31-60 Days', type: 'number' }, { key: 'd61_90', label: '61-90 Days', type: 'number' }, { key: 'd90', label: '> 90 Days', type: 'number' }, { key: 'total', label: 'Total', type: 'number' }], rows };
    },
  },
  committed_stock: {
    category: 'Inventory', title: 'Committed Stock Details', params: [],
    fn: () => {
      const rows = db().all<Row>("SELECT id, name, sku FROM items WHERE type = 'goods' AND track_inventory = 1 ORDER BY name").map((i) => {
        const s = stockSummary(i.id);
        return { item_id: i.id, name: i.name, sku: i.sku, physical: s.physical, committed: s.committed, available: s.available, incoming: s.incoming };
      }).filter((r) => r.committed || r.incoming);
      return { title: 'Committed Stock Details', columns: [{ key: 'name', label: 'Item', link: 'items' }, { key: 'physical', label: 'Stock On Hand', type: 'number' }, { key: 'committed', label: 'Committed', type: 'number' }, { key: 'available', label: 'Available for Sale', type: 'number' }, { key: 'incoming', label: 'Quantity to Receive', type: 'number' }], rows };
    },
  },
  reorder_report: {
    category: 'Inventory', title: 'Items Below Reorder Level', params: [],
    fn: () => {
      const rows = db().all<Row>(
        `SELECT i.id AS item_id, i.name, i.sku, i.reorder_level, v.name AS vendor, COALESCE((SELECT SUM(qty) FROM stock_moves WHERE item_id = i.id AND physical = 1),0) AS stock
         FROM items i LEFT JOIN contacts v ON v.id = i.preferred_vendor_id WHERE i.track_inventory = 1 AND i.reorder_level > 0 AND i.is_active = 1 ORDER BY i.name`)
        .map((r) => ({ ...r, stock: r2(r.stock), available: r2(r.stock - committedQty(r.item_id)) })).filter((r) => r.available <= r.reorder_level);
      return { title: 'Items Below Reorder Level', columns: [{ key: 'name', label: 'Item', link: 'items' }, { key: 'sku', label: 'SKU' }, { key: 'stock', label: 'Stock On Hand', type: 'number' }, { key: 'available', label: 'Available', type: 'number' }, { key: 'reorder_level', label: 'Reorder Level', type: 'number' }, { key: 'vendor', label: 'Preferred Vendor' }], rows };
    },
  },
  batch_serial_report: {
    category: 'Inventory', title: 'Batch & Serial Number Details', params: [],
    fn: () => {
      const d = db();
      const rows: Row[] = [];
      for (const i of d.all<Row>("SELECT id, name, tracking FROM items WHERE tracking <> 'none' ORDER BY name")) {
        for (const w of d.all<Row>('SELECT id, name FROM warehouses')) {
          if (i.tracking === 'batch') for (const b of availableBatches(i.id, w.id)) rows.push({ item: i.name, warehouse: w.name, type: 'Batch', number: b.batch_no, expiry_date: b.expiry_date, qty: r2(b.qty) });
          else for (const s of availableSerials(i.id, w.id)) rows.push({ item: i.name, warehouse: w.name, type: 'Serial', number: s, expiry_date: null, qty: 1 });
        }
      }
      return { title: 'Batch & Serial Number Details', columns: [{ key: 'item', label: 'Item' }, { key: 'warehouse', label: 'Warehouse' }, { key: 'type', label: 'Tracking' }, { key: 'number', label: 'Batch / Serial#' }, { key: 'expiry_date', label: 'Expiry', type: 'date' }, { key: 'qty', label: 'Quantity', type: 'number' }], rows };
    },
  },
  mo_summary: {
    category: 'Manufacturing', title: 'Manufacturing Order Summary', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(
        `SELECT mo.id, mo.number, mo.date, i.name AS item, mo.qty, mo.produced_qty, mo.rejected_qty, mo.status, mo.material_cost, mo.labour_cost, mo.overhead_cost,
           (mo.material_cost + mo.labour_cost + mo.overhead_cost) AS total_cost FROM manufacturing_orders mo JOIN items i ON i.id = mo.item_id
         WHERE mo.date BETWEEN ? AND ? ORDER BY mo.date DESC`, from, to).map((r) => ({ ...r, unit_cost: r.produced_qty ? r2(r.total_cost / r.produced_qty) : 0, yield_pct: r.produced_qty + r.rejected_qty ? r2((r.produced_qty / (r.produced_qty + r.rejected_qty)) * 100) : null }));
      return { title: 'Manufacturing Order Summary', subtitle: `${from} to ${to}`, columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'number', label: 'MO#', link: 'manufacturing/orders' }, { key: 'item', label: 'Item' }, { key: 'status', label: 'Status' }, { key: 'qty', label: 'Planned', type: 'number' }, { key: 'produced_qty', label: 'Produced', type: 'number' }, { key: 'rejected_qty', label: 'Rejected', type: 'number' }, { key: 'yield_pct', label: 'Yield %', type: 'percent' }, money('material_cost', 'Material'), money('labour_cost', 'Labour'), money('overhead_cost', 'Overhead'), money('unit_cost', 'Unit Cost')], rows, totals: { material_cost: sumBy(rows, 'material_cost'), labour_cost: sumBy(rows, 'labour_cost'), overhead_cost: sumBy(rows, 'overhead_cost') } };
    },
  },
  work_center_utilization: {
    category: 'Manufacturing', title: 'Work Centre Utilisation', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const days = Math.max(1, daysBetween(from, to) + 1);
      const rows = db().all<Row>(
        `SELECT w.id, w.name, w.capacity_hours, w.cost_per_hour, COALESCE(SUM(l.minutes),0) AS minutes, COUNT(DISTINCT jc.id) AS job_cards
         FROM work_centers w LEFT JOIN job_cards jc ON jc.work_center_id = w.id LEFT JOIN job_card_logs l ON l.job_card_id = jc.id AND substr(l.started_at,1,10) BETWEEN ? AND ?
         GROUP BY w.id ORDER BY w.name`, from, to).map((r) => {
        const hours = r2(r.minutes / 60), cap = r2(r.capacity_hours * days);
        return { ...r, hours, capacity: cap, utilization: cap ? r2((hours / cap) * 100) : 0, cost: r2(hours * r.cost_per_hour) };
      });
      return { title: 'Work Centre Utilisation', subtitle: `${from} to ${to}`, columns: [{ key: 'name', label: 'Work Centre' }, { key: 'job_cards', label: 'Job Cards', type: 'number' }, { key: 'hours', label: 'Hours Logged', type: 'number' }, { key: 'capacity', label: 'Capacity Hours', type: 'number' }, { key: 'utilization', label: 'Utilisation %', type: 'percent' }, money('cost', 'Labour Cost')], rows };
    },
  },
  salary_register: {
    category: 'Payroll', title: 'Salary Register', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(
        `SELECT r.period, e.emp_code, e.name, p.paid_days, p.lop_days, p.gross, p.total_deductions, p.net, p.employer_cost FROM payslips p JOIN pay_runs r ON r.id = p.pay_run_id
         JOIN employees e ON e.id = p.employee_id WHERE r.status IN ('approved','paid') AND r.period BETWEEN ? AND ? ORDER BY r.period, e.emp_code`, from.slice(0, 7), to.slice(0, 7));
      return { title: 'Salary Register', subtitle: `${from.slice(0, 7)} to ${to.slice(0, 7)}`, columns: [{ key: 'period', label: 'Period' }, { key: 'emp_code', label: 'Emp ID' }, { key: 'name', label: 'Employee' }, { key: 'paid_days', label: 'Paid Days', type: 'number' }, { key: 'lop_days', label: 'LOP Days', type: 'number' }, money('gross', 'Gross'), money('total_deductions', 'Deductions'), money('net', 'Net Pay'), money('employer_cost', 'Employer Contributions')], rows, totals: { gross: sumBy(rows, 'gross'), total_deductions: sumBy(rows, 'total_deductions'), net: sumBy(rows, 'net'), employer_cost: sumBy(rows, 'employer_cost') } };
    },
  },
  epf_summary: { category: 'Payroll', title: 'EPF Summary', params: ['from', 'to'], fn: (q) => payrollStat(q, 'EPF Summary', [{ field: 'deductions', code: 'EPF_EE', label: 'Employee EPF' }, { field: 'employer', code: 'EPF_ER', label: 'Employer EPF' }, { field: 'employer', code: 'EPS', label: 'EPS' }, { field: 'employer', code: 'EDLI', label: 'EDLI' }, { field: 'employer', code: 'PF_ADMIN', label: 'Admin Charges' }]) },
  esi_summary: { category: 'Payroll', title: 'ESI Summary', params: ['from', 'to'], fn: (q) => payrollStat(q, 'ESI Summary', [{ field: 'deductions', code: 'ESI_EE', label: 'Employee ESI' }, { field: 'employer', code: 'ESI_ER', label: 'Employer ESI' }]) },
  pt_summary: { category: 'Payroll', title: 'Professional Tax Summary', params: ['from', 'to'], fn: (q) => payrollStat(q, 'Professional Tax Summary', [{ field: 'deductions', code: 'PT', label: 'Professional Tax' }]) },
  tds_salary: { category: 'Payroll', title: 'TDS on Salary (Sec 192)', params: ['from', 'to'], fn: (q) => payrollStat(q, 'TDS on Salary (Sec 192)', [{ field: 'deductions', code: 'TDS', label: 'TDS Deducted' }]) },
  gst_summary: {
    category: 'Taxes', title: 'GST Summary', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const agg = (types: string[], sign: number) => db().all<Row>(
        `SELECT l.tax_rate AS rate, SUM(l.taxable * d.exchange_rate) AS taxable, SUM(l.cgst * d.exchange_rate) AS cgst, SUM(l.sgst * d.exchange_rate) AS sgst, SUM(l.igst * d.exchange_rate) AS igst
         FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE d.type IN (${types.map(() => '?').join(',')}) AND d.status IN ('open','partially_paid','paid','closed','recorded') AND d.date BETWEEN ? AND ? GROUP BY l.tax_rate`, ...types, from, to)
        .map((r) => ({ rate: r.rate, taxable: r2(sign * r.taxable), cgst: r2(sign * r.cgst), sgst: r2(sign * r.sgst), igst: r2(sign * r.igst) }));
      const rows = [
        ...agg(['invoice'], 1).map((r) => ({ ...r, type: 'Output - Sales' })), ...agg(['credit_note'], -1).map((r) => ({ ...r, type: 'Output - Credit Notes' })),
        ...agg(['bill', 'expense'], 1).map((r) => ({ ...r, type: 'Input - Purchases' })), ...agg(['vendor_credit'], -1).map((r) => ({ ...r, type: 'Input - Vendor Credits' })),
      ].map((r) => ({ ...r, total_tax: r2(r.cgst + r.sgst + r.igst) }));
      return { title: 'GST Summary', subtitle: `${from} to ${to}`, columns: [{ key: 'type', label: 'Type' }, { key: 'rate', label: 'GST Rate %', type: 'number' }, money('taxable', 'Taxable Amount'), money('cgst', 'CGST'), money('sgst', 'SGST'), money('igst', 'IGST'), money('total_tax', 'Total Tax')], rows };
    },
  },
  hsn_summary: {
    category: 'Taxes', title: 'HSN/SAC Summary', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(
        `SELECT COALESCE(l.hsn_code,'-') AS hsn, l.unit, l.tax_rate AS rate,
           SUM(CASE WHEN d.type = 'invoice' THEN l.qty ELSE -l.qty END) AS qty,
           SUM(CASE WHEN d.type = 'invoice' THEN 1 ELSE -1 END * l.taxable * d.exchange_rate) AS taxable,
           SUM(CASE WHEN d.type = 'invoice' THEN 1 ELSE -1 END * l.igst * d.exchange_rate) AS igst,
           SUM(CASE WHEN d.type = 'invoice' THEN 1 ELSE -1 END * l.cgst * d.exchange_rate) AS cgst,
           SUM(CASE WHEN d.type = 'invoice' THEN 1 ELSE -1 END * l.sgst * d.exchange_rate) AS sgst
         FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE d.type IN ('invoice','credit_note') AND d.status IN ('open','partially_paid','paid','closed') AND d.date BETWEEN ? AND ?
         GROUP BY l.hsn_code, l.unit, l.tax_rate ORDER BY l.hsn_code`, from, to).map((r) => ({ ...r, qty: r2(r.qty), taxable: r2(r.taxable), igst: r2(r.igst), cgst: r2(r.cgst), sgst: r2(r.sgst) }));
      return { title: 'HSN/SAC Summary', subtitle: `${from} to ${to}`, columns: [{ key: 'hsn', label: 'HSN/SAC' }, { key: 'unit', label: 'UQC' }, { key: 'rate', label: 'Rate %', type: 'number' }, { key: 'qty', label: 'Quantity', type: 'number' }, money('taxable', 'Taxable Value'), money('igst', 'IGST'), money('cgst', 'CGST'), money('sgst', 'SGST')], rows, totals: { taxable: sumBy(rows, 'taxable'), igst: sumBy(rows, 'igst'), cgst: sumBy(rows, 'cgst'), sgst: sumBy(rows, 'sgst') } };
    },
  },
  tds_payable: {
    category: 'Taxes', title: 'TDS Payable (Vendors)', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(
        `SELECT d.id, d.number, d.date, c.name AS vendor, c.pan, json_extract(d.data, '$.tds_section') AS section, json_extract(d.data, '$.tds_rate') AS rate, d.taxable_total, d.tds_amount
         FROM documents d JOIN contacts c ON c.id = d.contact_id WHERE d.type = 'bill' AND d.tds_amount > 0 AND d.status IN ('open','partially_paid','paid') AND d.date BETWEEN ? AND ? ORDER BY d.date`, from, to);
      return { title: 'TDS Payable (Vendors)', subtitle: `${from} to ${to}`, columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'number', label: 'Bill#', link: 'docs/bill' }, { key: 'vendor', label: 'Vendor' }, { key: 'pan', label: 'PAN' }, { key: 'section', label: 'Section' }, { key: 'rate', label: 'Rate %', type: 'number' }, money('taxable_total', 'Amount'), money('tds_amount', 'TDS')], rows, totals: { taxable_total: sumBy(rows, 'taxable_total'), tds_amount: sumBy(rows, 'tds_amount') } };
    },
  },
  audit_trail: {
    category: 'Activity', title: 'Audit Trail', params: ['from', 'to'],
    fn: (q) => {
      const { from, to } = period(q);
      const rows = db().all<Row>(`SELECT a.at, u.name AS user, a.entity, a.entity_id, a.action, a.summary FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE substr(a.at,1,10) BETWEEN ? AND ? ORDER BY a.id DESC LIMIT 2000`, from, to);
      return { title: 'Audit Trail', subtitle: `${from} to ${to}`, columns: [{ key: 'at', label: 'Time' }, { key: 'user', label: 'User' }, { key: 'entity', label: 'Module' }, { key: 'action', label: 'Action' }, { key: 'summary', label: 'Details' }], rows };
    },
  },
  email_log: {
    category: 'Activity', title: 'Email Log', params: [],
    fn: () => {
      const rows = db().all<Row>('SELECT at, to_addr, subject, entity, status FROM email_outbox ORDER BY id DESC LIMIT 1000');
      return { title: 'Email Log', columns: [{ key: 'at', label: 'Time' }, { key: 'to_addr', label: 'To' }, { key: 'subject', label: 'Subject' }, { key: 'entity', label: 'Module' }, { key: 'status', label: 'Status' }], rows };
    },
  },
};

export function runReport(key: string, q: Row): ReportResult {
  const r = REPORTS[key] ?? fail('Report not found', 404);
  return r.fn(q);
}

export function reportCatalog() {
  return Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, category: r.category, params: r.params ?? [] }));
}

export function toCsv(r: ReportResult): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [r.title, r.subtitle ?? ''];
  if (r.sections) {
    lines.push('Account,Amount');
    for (const s of r.sections) {
      lines.push(esc(s.title));
      for (const row of s.rows) lines.push(`${esc(row.account)},${row.amount}`);
      if (s.total !== undefined) lines.push(`${esc(`Total ${s.title}`)},${s.total}`);
    }
  } else {
    lines.push(r.columns.map((c) => esc(c.label)).join(','));
    for (const row of r.rows) lines.push(r.columns.map((c) => esc(row[c.key])).join(','));
    if (r.totals) lines.push(r.columns.map((c, i) => (i === 0 ? 'Total' : esc(r.totals![c.key] ?? ''))).join(','));
  }
  return lines.join('\n');
}
