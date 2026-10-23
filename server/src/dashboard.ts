import type { AuthUser } from './auth.js';
import { db, type Row } from './db.js';
import { createDocument, emailDocument } from './documents/engine.js';
import { DOC_TYPES } from './documents/types.js';
import { committedQty } from './inventory.js';
import { accountBalance } from './ledger.js';
import { org } from './settings.js';
import { addDays, addMonths, daysBetween, fiscalYear, monthEnd, r2, today } from './util.js';
import { audit } from './activity.js';
import { json, fail } from './db.js';

function agingTotals(type: 'invoice' | 'bill') {
  const t = today();
  const rows = db().all<Row>(`SELECT due_date, balance FROM documents WHERE type = ? AND status IN ('open','partially_paid')`, type);
  const out = { total: 0, current: 0, d1_15: 0, d16_30: 0, d31_45: 0, d45: 0 };
  for (const r of rows) {
    const age = daysBetween(r.due_date ?? t, t);
    const k = age <= 0 ? 'current' : age <= 15 ? 'd1_15' : age <= 30 ? 'd16_30' : age <= 45 ? 'd31_45' : 'd45';
    out[k] = r2(out[k] + r.balance);
    out.total = r2(out.total + r.balance);
  }
  return out;
}

export function dashboard(user?: AuthUser) {
  const d = db();
  const o = org();
  const t = today();
  const fy = fiscalYear(t, o.fiscal_year_start_month);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(fy.start, i)).filter((m) => m <= t);
  const monthly = months.map((m) => {
    const end = monthEnd(m);
    const sum = (sql: string) => r2(d.value<number>(sql, m, end) ?? 0);
    return {
      month: m.slice(0, 7),
      income: sum(`SELECT COALESCE(SUM(jl.credit - jl.debit),0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id WHERE a.type IN ('income','other_income') AND j.date BETWEEN ? AND ?`),
      expense: sum(`SELECT COALESCE(SUM(jl.debit - jl.credit),0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id WHERE a.type IN ('expense','cost_of_goods_sold','other_expense') AND j.date BETWEEN ? AND ?`),
      cash_in: sum(`SELECT COALESCE(SUM(jl.debit),0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id WHERE a.type IN ('cash','bank') AND j.date BETWEEN ? AND ? AND j.source_type NOT IN ('bank_txn_transfer')`),
      cash_out: sum(`SELECT COALESCE(SUM(jl.credit),0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id WHERE a.type IN ('cash','bank') AND j.date BETWEEN ? AND ?`),
      cash_balance: r2(d.value<number>(`SELECT COALESCE(SUM(jl.debit - jl.credit),0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id WHERE a.type IN ('cash','bank') AND j.date <= ?`, end) ?? 0),
    };
  });
  const topExpenses = d.all<Row>(
    `SELECT a.name, SUM(jl.debit - jl.credit) AS amount FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id
     WHERE a.type IN ('expense','other_expense','cost_of_goods_sold') AND j.date BETWEEN ? AND ? GROUP BY a.id HAVING amount > 0 ORDER BY amount DESC LIMIT 6`, fy.start, t)
    .map((r) => ({ ...r, amount: r2(r.amount) }));
  const banks = d.all<Row>("SELECT id, name, type FROM accounts WHERE type IN ('bank','cash','credit_card') AND is_active = 1 ORDER BY type, name").map((a) => ({ ...a, balance: accountBalance(a.id) }));
  const count = (sql: string, ...p: unknown[]) => d.value<number>(sql, ...p) ?? 0;
  const salesActivity = {
    to_be_packed: count(`SELECT COUNT(*) FROM documents so WHERE so.type = 'sales_order' AND so.status = 'confirmed' AND EXISTS (
      SELECT 1 FROM document_lines l JOIN items i ON i.id = l.item_id WHERE l.document_id = so.id AND i.type = 'goods' AND l.qty > COALESCE((SELECT SUM(pl.qty) FROM document_lines pl JOIN documents p ON p.id = pl.document_id WHERE pl.ref_line_id = l.id AND p.type IN ('package','delivery_challan')),0))`),
    to_be_shipped: count("SELECT COUNT(*) FROM documents WHERE type = 'package' AND status = 'packed'"),
    to_be_delivered: count("SELECT COUNT(*) FROM documents WHERE type = 'package' AND status = 'shipped'"),
    to_be_invoiced: count("SELECT COUNT(*) FROM documents WHERE type = 'sales_order' AND status = 'confirmed' AND COALESCE(billing_status,'not_invoiced') <> 'invoiced'"),
  };
  const lowStock = d.all<Row>(
    `SELECT i.id, i.name, i.reorder_level, COALESCE((SELECT SUM(qty) FROM stock_moves WHERE item_id = i.id AND physical = 1),0) AS stock
     FROM items i WHERE i.track_inventory = 1 AND i.reorder_level > 0 AND i.is_active = 1`).map((r) => ({ ...r, stock: r2(r.stock), available: r2(r.stock - committedQty(r.id)) })).filter((r) => r.available <= r.reorder_level);
  const inventory = {
    quantity_in_hand: r2(count("SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE physical = 1")),
    quantity_to_receive: r2(count(`SELECT COALESCE(SUM(l.qty - COALESCE((SELECT SUM(rl.qty) FROM document_lines rl JOIN documents r ON r.id = rl.document_id WHERE rl.ref_line_id = l.id AND r.type = 'purchase_receive'),0)),0)
      FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE d.type = 'purchase_order' AND d.status = 'issued'`)),
    stock_value: r2(count("SELECT COALESCE(SUM(value),0) FROM stock_moves WHERE accounting = 1")),
    active_items: count('SELECT COUNT(*) FROM items WHERE is_active = 1'),
    low_stock: lowStock.length,
  };
  const topItems = d.all<Row>(
    `SELECT COALESCE(i.name, l.description) AS name, SUM(l.qty) AS qty, SUM(l.taxable * d.exchange_rate) AS amount FROM document_lines l JOIN documents d ON d.id = l.document_id
     LEFT JOIN items i ON i.id = l.item_id WHERE d.type = 'invoice' AND d.status IN ('open','partially_paid','paid') AND d.date BETWEEN ? AND ?
     GROUP BY COALESCE(i.id, l.description) ORDER BY amount DESC LIMIT 5`, fy.start, t).map((r) => ({ ...r, qty: r2(r.qty), amount: r2(r.amount) }));
  const manufacturing = Object.fromEntries(d.all<Row>('SELECT status, COUNT(*) AS n FROM manufacturing_orders GROUP BY status').map((r) => [r.status, r.n]));
  const pendingApprovals = d.all<Row>("SELECT id, type, number, date, total FROM documents WHERE status = 'pending_approval' ORDER BY date LIMIT 20")
    .map((r) => ({ ...r, label: DOC_TYPES[r.type]?.label }));
  const receivables = agingTotals('invoice');
  const payables = agingTotals('bill');
  const billsDueSoon = d.all<Row>(`SELECT id, number, due_date, balance FROM documents WHERE type = 'bill' AND status IN ('open','partially_paid') AND due_date BETWEEN ? AND ? ORDER BY due_date`, t, addDays(t, 7));
  const uncategorized = count("SELECT COUNT(*) FROM bank_statement_lines WHERE status = 'uncategorized'");
  const thisMonth = t.slice(0, 7);
  const day = Number(t.slice(8, 10));
  // Monthly filers: GSTR-1 by the 11th and GSTR-3B by the 20th of the following month.
  const returnPeriod = day > 20 ? thisMonth : addMonths(`${thisMonth}-01`, -1).slice(0, 7);
  const dueMonth = addMonths(`${returnPeriod}-01`, 1).slice(0, 7);
  const label = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const insights: { level: 'info' | 'warning' | 'critical'; text: string; link?: string }[] = [];
  if (receivables.total - receivables.current > 0) insights.push({ level: 'warning', text: `₹${r2(receivables.total - receivables.current).toLocaleString('en-IN')} of receivables is overdue across ${count("SELECT COUNT(*) FROM documents WHERE type = 'invoice' AND status IN ('open','partially_paid') AND due_date < ?", t)} invoice(s).`, link: '/docs/invoice?status=overdue' });
  if (billsDueSoon.length) insights.push({ level: 'info', text: `${billsDueSoon.length} bill(s) totalling ₹${r2(billsDueSoon.reduce((a, b) => a + b.balance, 0)).toLocaleString('en-IN')} fall due in the next 7 days.`, link: '/docs/bill?status=unpaid' });
  if (lowStock.length) insights.push({ level: 'warning', text: `${lowStock.length} item(s) are at or below their reorder level.`, link: '/reports/reorder_report' });
  if (pendingApprovals.length) insights.push({ level: 'info', text: `${pendingApprovals.length} transaction(s) are waiting for approval.` });
  if (uncategorized) insights.push({ level: 'info', text: `${uncategorized} bank statement line(s) need to be categorised or matched.`, link: '/banking' });
  if (o.gstin) {
    const r1 = `${dueMonth}-11`, r3 = `${dueMonth}-20`;
    const parts = [r1 >= t ? `GSTR-1 by ${r1}` : null, `GSTR-3B by ${r3}`].filter(Boolean).join(' and ');
    insights.push({ level: 'info', text: `${label(returnPeriod)} returns: file ${parts} (monthly filers).`, link: `/compliance/gstr3b` });
  }
  const cashBurn = monthly.length >= 2 ? r2(monthly.slice(-3).reduce((a, m) => a + (m.cash_out - m.cash_in), 0) / Math.min(3, monthly.length)) : 0;
  const cashNow = banks.filter((b) => b.type !== 'credit_card').reduce((a, b) => a + b.balance, 0);
  if (cashBurn > 0 && cashNow > 0) insights.push({ level: cashNow / cashBurn < 3 ? 'critical' : 'info', text: `At the recent average net cash outflow of ₹${cashBurn.toLocaleString('en-IN')}/month, cash on hand covers about ${r2(cashNow / cashBurn)} month(s).` });
  return {
    org: { name: o.name, setup_complete: o.setup_complete }, fiscal_year: fy, receivables, payables, monthly, top_expenses: topExpenses, banks,
    sales_activity: salesActivity, inventory, low_stock: lowStock.slice(0, 10), top_items: topItems, manufacturing, pending_approvals: pendingApprovals,
    bills_due_soon: billsDueSoon, insights, user: user?.name,
  };
}

export function globalSearch(q: string) {
  const d = db();
  const like = `%${q}%`;
  if (!q || q.length < 2) return [];
  const out: Row[] = [];
  for (const c of d.all<Row>('SELECT id, kind, name, email, gstin FROM contacts WHERE name LIKE ? OR email LIKE ? OR gstin LIKE ? OR company_name LIKE ? LIMIT 8', like, like, like, like)) {
    out.push({ type: c.kind, label: c.name, sub: c.gstin ?? c.email ?? '', link: `/${c.kind === 'customer' ? 'customers' : 'vendors'}/${c.id}` });
  }
  for (const i of d.all<Row>('SELECT id, name, sku FROM items WHERE name LIKE ? OR sku LIKE ? OR hsn_code LIKE ? LIMIT 8', like, like, like)) {
    out.push({ type: 'item', label: i.name, sub: i.sku ?? '', link: `/items/${i.id}` });
  }
  for (const doc of d.all<Row>('SELECT d.id, d.type, d.number, d.total, c.name FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.number LIKE ? OR d.reference LIKE ? ORDER BY d.id DESC LIMIT 12', like, like)) {
    out.push({ type: DOC_TYPES[doc.type]?.label ?? doc.type, label: doc.number, sub: `${doc.name ?? ''} ₹${doc.total}`, link: `/docs/${doc.type}/${doc.id}` });
  }
  for (const p of d.all<Row>('SELECT p.id, p.kind, p.number, p.amount, c.name FROM payments p JOIN contacts c ON c.id = p.contact_id WHERE p.number LIKE ? OR p.reference LIKE ? LIMIT 6', like, like)) {
    out.push({ type: p.kind === 'received' ? 'Payment Received' : 'Payment Made', label: p.number, sub: `${p.name} ₹${p.amount}`, link: `/payments/${p.kind}/${p.id}` });
  }
  for (const m of d.all<Row>('SELECT mo.id, mo.number, i.name FROM manufacturing_orders mo JOIN items i ON i.id = mo.item_id WHERE mo.number LIKE ? LIMIT 5', like)) {
    out.push({ type: 'Manufacturing Order', label: m.number, sub: m.name, link: `/manufacturing/orders/${m.id}` });
  }
  for (const e of d.all<Row>('SELECT id, name, emp_code FROM employees WHERE name LIKE ? OR emp_code LIKE ? LIMIT 5', like, like)) {
    out.push({ type: 'Employee', label: e.name, sub: e.emp_code, link: `/payroll/employees/${e.id}` });
  }
  return out;
}

// ---------------- Recurring invoices ----------------

const advance = (date: string, freq: string, every: number) =>
  freq === 'weekly' ? addDays(date, 7 * every) : freq === 'quarterly' ? addMonths(date, 3 * every) : freq === 'yearly' ? addMonths(date, 12 * every) : addMonths(date, every);

export function saveRecurring(input: Row, id?: number) {
  const d = db();
  const c = d.get<Row>("SELECT * FROM contacts WHERE id = ? AND kind = 'customer'", input.contact_id) ?? fail('Customer not found', 422);
  if (!['weekly', 'monthly', 'quarterly', 'yearly'].includes(input.frequency)) fail('Invalid frequency', 422);
  if (!input.start_date) fail('Start date is required', 422);
  if (!Array.isArray(input.template?.lines) || !input.template.lines.length) fail('Add at least one line item', 422);
  const row = { name: String(input.name ?? '').trim() || `${c.name} recurring`, contact_id: c.id, frequency: input.frequency, every: Math.max(1, Number(input.every) || 1), start_date: input.start_date, end_date: input.end_date || null, next_date: input.next_date ?? input.start_date, status: input.status === 'stopped' ? 'stopped' : 'active', template: JSON.stringify(input.template), auto_send: input.auto_send ? 1 : 0 };
  if (id) { d.update('recurring_profiles', id, row); return id; }
  return d.insert('recurring_profiles', row);
}

/** Generates all invoices that are due up to `upto` for active recurring profiles. */
export function runRecurring(upto = today(), user?: AuthUser) {
  const d = db();
  const created: number[] = [];
  for (const p of d.all<Row>("SELECT * FROM recurring_profiles WHERE status = 'active' AND next_date <= ?", upto)) {
    let next = p.next_date;
    let guard = 0;
    while (next <= upto && (!p.end_date || next <= p.end_date) && guard++ < 60) {
      const tpl = json<Row>(p.template, {});
      const id = createDocument('invoice', { ...tpl, contact_id: p.contact_id, date: next, due_date: undefined, reference: `Recurring: ${p.name}` }, user, { submit: true });
      if (p.auto_send && d.value<string>('SELECT email FROM contacts WHERE id = ?', p.contact_id)) emailDocument(id, undefined, user);
      created.push(id);
      next = advance(next, p.frequency, p.every);
    }
    d.update('recurring_profiles', p.id, { next_date: next, status: p.end_date && next > p.end_date ? 'expired' : 'active' });
    audit('recurring', p.id, 'generated', `Generated invoices up to ${upto}`, user);
  }
  return created;
}
