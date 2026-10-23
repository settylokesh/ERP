import { ArrowLeft, Download, Printer, Star } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { download, qs } from '../api';
import { ErrorBox, Input, PageHeader, Spinner } from '../components/ui';
import { date, money, qty } from '../lib/format';
import { useApi } from '../lib/hooks';

const FAV_KEY = 'saral.report_favourites';
const readFavs = (): string[] => { try { return JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]'); } catch { return []; } };

function Catalog() {
  const { data } = useApi<any[]>('/reports');
  const { data: budgets } = useApi<any[]>('/budgets');
  const [favs, setFavs] = useState<string[]>(readFavs());
  const [q, setQ] = useState('');
  const toggle = (k: string) => {
    const next = favs.includes(k) ? favs.filter((x) => x !== k) : [...favs, k];
    setFavs(next);
    try { localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const groups = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const r of (data ?? []).filter((r) => r.title.toLowerCase().includes(q.toLowerCase()))) m.set(r.category, [...(m.get(r.category) ?? []), r]);
    return [...m.entries()];
  }, [data, q]);
  if (!data) return <Spinner />;
  return (
    <div>
      <PageHeader title="Reports" subtitle={`${data.length} reports across finance, sales, purchases, inventory, manufacturing, payroll and tax`} actions={<Input className="w-64" placeholder="Search reports" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search reports" />} />
      <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
        {favs.length > 0 && (
          <div className="card p-4"><h3 className="mb-2">Favourites</h3>
            {data.filter((r) => favs.includes(r.key)).map((r) => <div key={r.key}><Link to={`/reports/${r.key}`}>{r.title}</Link></div>)}</div>
        )}
        {groups.map(([cat, rs]) => (
          <div key={cat} className="card p-4">
            <h3 className="mb-2">{cat}</h3>
            <ul className="space-y-1">{rs.map((r) => (
              <li key={r.key} className="flex items-center justify-between gap-2">
                <Link to={`/reports/${r.key}`}>{r.title}</Link>
                <button onClick={() => toggle(r.key)} aria-label={`Favourite ${r.title}`}><Star className={`h-3.5 w-3.5 ${favs.includes(r.key) ? 'fill-amber-400 text-amber-500' : 'text-slate-300'}`} /></button>
              </li>
            ))}</ul>
          </div>
        ))}
        {(budgets ?? []).length > 0 && (
          <div className="card p-4"><h3 className="mb-2">Budgets</h3>{budgets!.map((b) => <div key={b.id}><Link to={`/reports/budget/${b.id}`}>Budget vs Actual — {b.name}</Link></div>)}</div>
        )}
      </div>
    </div>
  );
}

const fyStart = () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-04-01`; };
const todayIso = () => new Date().toISOString().slice(0, 10);
const PRESETS: [string, () => [string, string]][] = [
  ['This month', () => { const d = new Date(); return [`${d.toISOString().slice(0, 7)}-01`, todayIso()]; }],
  ['Last month', () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); const s = d.toISOString().slice(0, 7); const e = new Date(d.getFullYear(), d.getMonth() + 1, 0); return [`${s}-01`, `${s}-${String(e.getDate()).padStart(2, '0')}`]; }],
  ['This fiscal year', () => [fyStart(), todayIso()]],
  ['Last fiscal year', () => { const s = fyStart(); const y = Number(s.slice(0, 4)) - 1; return [`${y}-04-01`, `${y + 1}-03-31`]; }],
];

function cell(v: any, type?: string) {
  if (v == null || v === '') return '';
  if (type === 'money') return money(v);
  if (type === 'number') return typeof v === 'number' ? qty(v) : v;
  if (type === 'percent') return `${qty(v)}%`;
  if (type === 'date') return date(v);
  return String(v);
}

function Viewer() {
  const { key = '' } = useParams();
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(todayIso());
  const { data: cat } = useApi<any[]>('/reports');
  const meta = cat?.find((r) => r.key === key);
  const params = meta ? { ...(meta.params.includes('from') ? { from } : {}), ...(meta.params.includes('to') ? { to } : {}) } : {};
  const { data: r, error, loading } = useApi<any>(meta ? `/reports/${key}${qs(params)}` : null);
  const nav = useNavigate();
  return (
    <div>
      <PageHeader title={r?.title ?? meta?.title ?? 'Report'} subtitle={r?.subtitle} back={<Link to="/reports" className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />Reports</Link>}
        actions={<>
          {meta?.params.includes('from') && <select className="input w-40" onChange={(e) => { const p = PRESETS.find(([l]) => l === e.target.value); if (p) { const [a, b] = p[1](); setFrom(a); setTo(b); } }} aria-label="Date range preset" defaultValue=""><option value="" disabled>Date range…</option>{PRESETS.map(([l]) => <option key={l}>{l}</option>)}</select>}
          {meta?.params.includes('from') && <Input type="date" className="w-36" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />}
          {meta?.params.includes('to') && <Input type="date" className="w-36" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />}
          <button className="btn" onClick={() => download(`/reports/${key}.csv${qs(params)}`, `${key}.csv`)}><Download className="h-4 w-4" />CSV</button>
          <button className="btn" onClick={() => window.print()}><Printer className="h-4 w-4" />Print</button>
        </>} />
      <div className="p-5">
        <ErrorBox error={error} />
        {loading || !r ? <Spinner /> : (
          <div className="card print-area overflow-x-auto p-5">
            <div className="mb-3 hidden text-center print:block"><div className="text-base font-semibold">{r.title}</div><div className="text-xs">{r.subtitle}</div></div>
            {r.meta?.balanced === false && <div className="mb-3 rounded bg-red-50 p-2 text-red-700">Warning: this report does not balance.</div>}
            {r.meta?.reconciled === false && <div className="mb-3 rounded bg-amber-50 p-2 text-amber-800">Stock valuation differs from the Inventory Asset ledger ({money(r.meta.ledger_balance)}).</div>}
            {r.sections ? (
              <table className="table">
                <thead><tr><th>Account</th><th className="num">Amount</th></tr></thead>
                <tbody>{r.sections.map((s: any) => (
                  <SectionRows key={s.title} s={s} onAccount={(id) => nav(`/accountant/accounts/${id}`)} />
                ))}</tbody>
                {r.meta?.total_assets !== undefined && <tfoot><tr><td className="font-semibold">Total Assets</td><td className="num font-semibold">{money(r.meta.total_assets)}</td></tr><tr><td className="font-semibold">Total Liabilities & Equity</td><td className="num font-semibold">{money(r.meta.liabilities_and_equity)}</td></tr></tfoot>}
              </table>
            ) : r.rows.length === 0 ? <div className="p-8 text-center text-slate-500">No data for the selected period.</div> : (
              <table className="table">
                <thead><tr>{r.columns.map((c: any) => <th key={c.key} className={['money', 'number', 'percent'].includes(c.type) ? 'num' : ''}>{c.label}</th>)}</tr></thead>
                <tbody>{r.rows.map((row: any, i: number) => (
                  <tr key={i}>{r.columns.map((c: any) => {
                    const v = cell(row[c.key], c.type);
                    const linkId = c.link === 'accounts' ? row.account_id : c.link === 'items' ? row.item_id : c.link?.startsWith('docs/') || c.link === 'manufacturing/orders' ? row.id : c.link === 'customers' || c.link === 'vendors' ? row.contact_id : null;
                    return <td key={c.key} className={['money', 'number', 'percent'].includes(c.type) ? 'num' : ''}>{c.link && linkId ? <Link to={c.link === 'accounts' ? `/accountant/accounts/${linkId}` : `/${c.link}/${linkId}`}>{v}</Link> : v}</td>;
                  })}</tr>
                ))}</tbody>
                {r.totals && <tfoot><tr>{r.columns.map((c: any, i: number) => <td key={c.key} className={`font-semibold ${['money', 'number', 'percent'].includes(c.type) ? 'num' : ''}`}>{i === 0 ? 'Total' : r.totals[c.key] !== undefined ? cell(r.totals[c.key], c.type) : ''}</td>)}</tr></tfoot>}
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionRows({ s, onAccount }: { s: any; onAccount: (id: number) => void }) {
  const isTotalOnly = s.rows.length === 0;
  return (
    <>
      <tr><td className={`font-semibold ${isTotalOnly ? 'text-slate-900' : 'text-slate-700'}`}>{s.title}</td><td className="num font-semibold">{isTotalOnly ? money(s.total) : ''}</td></tr>
      {s.rows.map((r: any, i: number) => (
        <tr key={i}><td className="pl-8">{r.account_id ? <button className="link" onClick={() => onAccount(r.account_id)}>{r.account}</button> : r.account}</td><td className="num">{money(r.amount)}</td></tr>
      ))}
      {!isTotalOnly && <tr><td className="pl-4 text-slate-600">Total for {s.title}</td><td className="num font-medium">{money(s.total)}</td></tr>}
    </>
  );
}

function BudgetReport() {
  const { id } = useParams();
  const { data: b } = useApi<any>(`/budgets/${id}/report`);
  if (!b) return <Spinner />;
  return (
    <div>
      <PageHeader title={`Budget vs Actual — ${b.name}`} back={<Link to="/reports" className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />Reports</Link>} actions={<button className="btn" onClick={() => window.print()}><Printer className="h-4 w-4" />Print</button>} />
      <div className="p-5"><div className="card print-area overflow-x-auto p-4">
        <table className="table min-w-[1200px]">
          <thead><tr><th>Account</th>{b.months.map((m: string) => <th key={m} className="num">{new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short' })}</th>)}<th className="num">Budget</th><th className="num">Actual</th><th className="num">Variance</th></tr></thead>
          <tbody>{b.lines.map((l: any) => (
            <tr key={l.account_id}>
              <td>{l.account_name}</td>
              {b.months.map((m: string, i: number) => <td key={m} className="num text-xs"><div>{qty(l.actual[i])}</div><div className="text-slate-500">{qty(l.budget[i])}</div></td>)}
              <td className="num">{money(l.total_budget)}</td><td className="num">{money(l.total_actual)}</td>
              <td className={`num font-medium ${(l.category === 'income' ? l.variance < 0 : l.variance > 0) ? 'text-red-600' : 'text-emerald-700'}`}>{money(l.variance)}{l.variance_pct != null && <div className="text-[10px]">{qty(l.variance_pct)}%</div>}</td>
            </tr>
          ))}</tbody>
        </table>
        <p className="mt-2 text-xs text-slate-500">Each month shows actual (top) and budget (below). Unfavourable variances are red.</p>
      </div></div>
    </div>
  );
}

export default function Reports() {
  return (
    <Routes>
      <Route index element={<Catalog />} />
      <Route path="budget/:id" element={<BudgetReport />} />
      <Route path=":key" element={<Viewer />} />
    </Routes>
  );
}
