import { AlertTriangle, ArrowRight, CircleAlert, Info } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ColumnChart, HBarChart, Legend, LineChart, SERIES } from '../components/charts';
import { ErrorBox, PageHeader, Spinner } from '../components/ui';
import { money, qty } from '../lib/format';
import { useApi, useCan } from '../lib/hooks';

function AgingCard({ title, data, link }: { title: string; data: any; link: string }) {
  const overdue = data.total - data.current;
  const rows = [['Current', data.current], ['1-15 days', data.d1_15], ['16-30 days', data.d16_30], ['31-45 days', data.d31_45], ['Above 45 days', data.d45]] as [string, number][];
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <h3>{title}</h3>
        <Link to={link} className="text-xs no-underline">View <ArrowRight className="inline h-3 w-3" /></Link>
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{money(data.total)}</div>
      <div className="text-xs text-slate-500">Total unpaid · <span className={overdue > 0 ? 'font-medium text-red-600' : ''}>{money(overdue)} overdue</span></div>
      <table className="mt-3 w-full text-xs">
        <tbody>{rows.map(([k, v]) => <tr key={k} className="border-t border-slate-100"><td className="py-1 text-slate-600">{k}</td><td className="py-1 text-right tabular-nums">{money(v)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export default function Dashboard() {
  const { data, error, loading } = useApi<any>('/dashboard');
  const can = useCan();
  if (loading && !data) return <Spinner />;
  if (error || !data) return <div className="p-6"><ErrorBox error={error} /></div>;
  const icon = (l: string) => (l === 'critical' ? <CircleAlert className="h-4 w-4 shrink-0 text-red-600" /> : l === 'warning' ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" /> : <Info className="h-4 w-4 shrink-0 text-brand-600" />);
  const totalIncome = data.monthly.reduce((a: number, m: any) => a + m.income, 0);
  const totalExpense = data.monthly.reduce((a: number, m: any) => a + m.expense, 0);
  return (
    <div>
      <PageHeader title={`Hello, ${data.user ?? ''}`} subtitle={`${data.org.name} · Fiscal year ${data.fiscal_year.label}`} />
      <div className="space-y-5 p-5">
        {data.insights.length > 0 && (
          <div className="card divide-y divide-slate-100">
            <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Assistant insights</div>
            {data.insights.map((i: any, k: number) => (
              <div key={k} className="flex items-center gap-2 px-4 py-2 text-[13px]">
                {icon(i.level)}<span className="flex-1">{i.text}</span>
                {i.link && <Link to={i.link} className="text-xs no-underline">Open</Link>}
              </div>
            ))}
          </div>
        )}
        <div className="grid gap-5 lg:grid-cols-2">
          {can('sales') && <AgingCard title="Total Receivables" data={data.receivables} link="/reports/ar_aging_summary" />}
          {can('purchases') && <AgingCard title="Total Payables" data={data.payables} link="/reports/ap_aging_summary" />}
        </div>
        {can('reports') && (
          <div className="grid gap-5 xl:grid-cols-3">
            <div className="card p-4 xl:col-span-2">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div><h3>Income and Expense</h3><div className="text-xs text-slate-500">This fiscal year · income {money(totalIncome)} · expense {money(totalExpense)}</div></div>
                <Legend items={[{ label: 'Income', color: SERIES[0] }, { label: 'Expense', color: SERIES[1] }]} />
              </div>
              <ColumnChart data={data.monthly} series={[{ key: 'income', label: 'Income' }, { key: 'expense', label: 'Expense' }]} />
            </div>
            <div className="card p-4">
              <h3>Top Expenses</h3>
              <div className="mb-3 text-xs text-slate-500">This fiscal year</div>
              {data.top_expenses.length ? <HBarChart data={data.top_expenses} labelKey="name" valueKey="amount" /> : <div className="text-slate-500">No expenses yet</div>}
            </div>
          </div>
        )}
        {can('banking') && (
          <div className="grid gap-5 xl:grid-cols-3">
            <div className="card p-4 xl:col-span-2">
              <h3>Cash Flow</h3>
              <div className="mb-2 text-xs text-slate-500">Closing balance of cash and bank accounts at each month end</div>
              <LineChart data={data.monthly} valueKey="cash_balance" label="Cash balance" />
            </div>
            <div className="card p-4">
              <div className="mb-2 flex items-center justify-between"><h3>Bank and Cash</h3><Link to="/banking" className="text-xs no-underline">Banking</Link></div>
              <table className="w-full text-[13px]"><tbody>
                {data.banks.map((b: any) => <tr key={b.id} className="border-t border-slate-100"><td className="py-1.5"><Link to={`/banking/${b.id}`}>{b.name}</Link></td><td className="py-1.5 text-right tabular-nums">{money(b.balance)}</td></tr>)}
              </tbody></table>
            </div>
          </div>
        )}
        <div className="grid gap-5 lg:grid-cols-3">
          {can('sales') && (
            <div className="card p-4">
              <h3 className="mb-3">Sales Activity</h3>
              <div className="grid grid-cols-2 gap-3 text-center">
                {[['To be packed', data.sales_activity.to_be_packed, '/docs/sales_order?status=confirmed'], ['To be shipped', data.sales_activity.to_be_shipped, '/docs/package?status=packed'], ['To be delivered', data.sales_activity.to_be_delivered, '/docs/package?status=shipped'], ['To be invoiced', data.sales_activity.to_be_invoiced, '/docs/sales_order?status=confirmed']].map(([l, v, to]) => (
                  <Link key={l as string} to={to as string} className="rounded-md bg-slate-50 p-3 no-underline hover:bg-slate-100"><div className="text-2xl font-semibold text-slate-900">{v as number}</div><div className="text-xs text-slate-500">{l as string}</div></Link>
                ))}
              </div>
            </div>
          )}
          {can('items') && (
            <div className="card p-4">
              <h3 className="mb-3">Inventory Summary</h3>
              <dl className="space-y-2 text-[13px]">
                <div className="flex justify-between"><dt className="text-slate-500">Quantity in hand</dt><dd className="tabular-nums">{qty(data.inventory.quantity_in_hand)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Quantity to be received</dt><dd className="tabular-nums">{qty(data.inventory.quantity_to_receive)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Stock value</dt><dd className="tabular-nums">{money(data.inventory.stock_value)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Active items</dt><dd>{data.inventory.active_items}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Low stock items</dt><dd className={data.inventory.low_stock ? 'font-medium text-amber-700' : ''}>{data.inventory.low_stock}</dd></div>
              </dl>
            </div>
          )}
          {can('sales') && (
            <div className="card p-4">
              <h3 className="mb-3">Top Selling Items</h3>
              {data.top_items.length === 0 ? <div className="text-slate-500">No sales yet</div> : (
                <table className="w-full text-[13px]"><tbody>
                  {data.top_items.map((i: any) => <tr key={i.name} className="border-t border-slate-100"><td className="py-1.5">{i.name}<div className="text-[11px] text-slate-500">{qty(i.qty)} sold</div></td><td className="py-1.5 text-right tabular-nums">{money(i.amount)}</td></tr>)}
                </tbody></table>
              )}
            </div>
          )}
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          {can('manufacturing') && (
            <div className="card p-4">
              <div className="mb-3 flex items-center justify-between"><h3>Manufacturing</h3><Link to="/manufacturing/orders" className="text-xs no-underline">Orders</Link></div>
              <div className="grid grid-cols-4 gap-2 text-center">
                {['draft', 'confirmed', 'in_progress', 'completed'].map((s) => <div key={s} className="rounded-md bg-slate-50 p-2"><div className="text-xl font-semibold">{data.manufacturing[s] ?? 0}</div><div className="text-[11px] capitalize text-slate-500">{s.replace('_', ' ')}</div></div>)}
              </div>
            </div>
          )}
          <div className="card p-4">
            <h3 className="mb-3">Pending Approvals</h3>
            {data.pending_approvals.length === 0 ? <div className="text-slate-500">Nothing awaiting approval.</div> : (
              <table className="w-full text-[13px]"><tbody>
                {data.pending_approvals.map((p: any) => <tr key={p.id} className="border-t border-slate-100"><td className="py-1.5"><Link to={`/docs/${p.type}/${p.id}`}>{p.number}</Link> <span className="text-xs text-slate-500">{p.label}</span></td><td className="py-1.5 text-right tabular-nums">{money(p.total)}</td></tr>)}
              </tbody></table>
            )}
          </div>
        </div>
        {data.low_stock.length > 0 && (
          <div className="card p-4">
            <h3 className="mb-2">Items below reorder level</h3>
            <table className="table"><thead><tr><th>Item</th><th className="num">Stock on hand</th><th className="num">Available</th><th className="num">Reorder level</th></tr></thead>
              <tbody>{data.low_stock.map((i: any) => <tr key={i.id}><td><Link to={`/items/${i.id}`}>{i.name}</Link></td><td className="num">{qty(i.stock)}</td><td className="num">{qty(i.available)}</td><td className="num">{qty(i.reorder_level)}</td></tr>)}</tbody></table>
          </div>
        )}
      </div>
    </div>
  );
}
