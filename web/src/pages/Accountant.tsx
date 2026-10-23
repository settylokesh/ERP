import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { del, get, post, put } from '../api';
import { DataTable } from '../components/DataTable';
import { AccountPicker, Combo, useContacts } from '../components/pickers';
import { Badge, Check, Confirm, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, useAction } from '../components/ui';
import { date, money, titleCase, today } from '../lib/format';
import { useApi, useCan, useMeta } from '../lib/hooks';

function Accounts() {
  const { data, loading, reload } = useApi<any[]>('/accounts?active=all');
  const { meta } = useMeta();
  const can = useCan();
  const nav = useNavigate();
  const [edit, setEdit] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const { run, busy } = useAction();
  const cats = ['asset', 'liability', 'equity', 'income', 'expense'];
  const rows = (data ?? []).filter((a) => !filter || a.category === filter);
  return (
    <div>
      <PageHeader title="Chart of Accounts" actions={can('accountant', 'create') && <button className="btn btn-primary" onClick={() => setEdit({ type: 'expense' })}><Plus className="h-4 w-4" />New Account</button>} />
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap gap-1">{['', ...cats].map((c) => <button key={c} className={`chip cursor-pointer px-3 py-1 ${filter === c ? 'bg-brand-600 text-white' : 'bg-white ring-1 ring-slate-200'}`} onClick={() => setFilter(c)}>{c ? titleCase(c) : 'All'}</button>)}</div>
        {loading && !data ? <Spinner /> : (
          <DataTable exportName="chart_of_accounts" rows={rows} onRow={(r) => nav(`/accountant/accounts/${r.id}`)} cols={[
            { key: 'code', label: 'Code' },
            { key: 'name', label: 'Account Name', render: (r) => <span className="link">{r.name}{r.system_key && <span className="ml-1 text-[10px] text-slate-400">SYSTEM</span>}{!r.is_active && <span className="ml-1 text-xs text-slate-400">(inactive)</span>}</span> },
            { key: 'type', label: 'Account Type', render: (r) => meta.account_types[r.type]?.label },
            { key: 'balance', label: 'Balance', num: true, render: (r) => money(r.balance) },
            { key: 'edit', label: '', render: (r) => can('accountant', 'edit') && <button className="text-xs text-brand-600" onClick={(e) => { e.stopPropagation(); setEdit(r); }}>Edit</button> },
          ]} />
        )}
      </div>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New account'} onClose={() => setEdit(null)} footer={<>
          {edit.id && !edit.system_key && can('accountant', 'delete') && <button className="btn btn-danger mr-auto" onClick={async () => { if (await run(() => del(`/accounts/${edit.id}`), 'Account deleted')) { setEdit(null); reload(); } }}>Delete</button>}
          <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (edit.id ? put(`/accounts/${edit.id}`, edit) : post('/accounts', edit)), 'Account saved')) { setEdit(null); reload(); } }}>Save</button></>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Account Type"><Select value={edit.type} disabled={!!edit.system_key} onChange={(e) => setEdit({ ...edit, type: e.target.value })} options={Object.entries(meta.account_types).map(([v, t]) => ({ value: v, label: `${t.label} (${t.category})` }))} /></Field>
            <Field label="Account Code"><Input value={edit.code ?? ''} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
            <Field label="Account Name" className="sm:col-span-2"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Parent Account" className="sm:col-span-2"><AccountPicker value={edit.parent_id} onChange={(v) => setEdit({ ...edit, parent_id: v })} categories={[meta.account_types[edit.type]?.category]} placeholder="None" /></Field>
            {['bank', 'credit_card'].includes(edit.type) && <>
              <Field label="Bank Name"><Input value={edit.bank_name ?? ''} onChange={(e) => setEdit({ ...edit, bank_name: e.target.value })} /></Field>
              <Field label="Account Number"><Input value={edit.account_number ?? ''} onChange={(e) => setEdit({ ...edit, account_number: e.target.value })} /></Field>
              <Field label="IFSC"><Input value={edit.ifsc ?? ''} onChange={(e) => setEdit({ ...edit, ifsc: e.target.value.toUpperCase() })} /></Field>
            </>}
            <Field label="Description" className="sm:col-span-2"><Textarea value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            {!edit.system_key && <Check label="Active" checked={edit.is_active !== 0 && edit.is_active !== false} onChange={(v) => setEdit({ ...edit, is_active: v })} />}
          </div>
        </Modal>
      )}
    </div>
  );
}

export function sourceLink(r: any): string | null {
  const t = r.source_type;
  if (!t) return null;
  if (t === 'manual_journal') return `/accountant/journals/${r.source_id}`;
  if (t === 'payment') return null;
  if (t === 'mo') return `/manufacturing/orders/${r.source_id}`;
  if (t === 'item_opening') return `/items/${r.source_id}`;
  if (t === 'contact_opening') return null;
  if (t.startsWith('asset')) return null;
  if (t.startsWith('pay_run')) return `/payroll/pay-runs/${r.source_id}`;
  if (['bank_txn', 'refund', 'payslip_release'].includes(t)) return null;
  return `/docs/${t}/${r.source_id}`;
}

function AccountView() {
  const { id } = useParams();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data, loading, error } = useApi<any>(`/accounts/${id}/transactions?from=${from}&to=${to}`);
  const { meta } = useMeta();
  const nav = useNavigate();
  if (loading && !data) return <Spinner />;
  if (error || !data) return <div className="p-6"><ErrorBox error={error} /></div>;
  return (
    <div>
      <PageHeader title={data.account.name} subtitle={`${meta.account_types[data.account.type]?.label} · Closing balance ${money(data.closing)}`} back={<Link to="/accountant/accounts" className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />Chart of Accounts</Link>} />
      <div className="space-y-3 p-5">
        <div className="flex gap-2"><Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" /><Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" /></div>
        {from && <div className="text-xs text-slate-500">Opening balance: {money(data.opening)}</div>}
        <DataTable exportName={`account_${id}`} rows={data.rows} onRow={(r) => { const l = sourceLink(r); if (l) nav(l); else if (r.source_type === 'payment') nav(`/payments/${r.debit && data.account.type !== 'accounts_payable' ? 'received' : 'made'}/${r.source_id}`); }} cols={[
          { key: 'date', label: 'Date', render: (r) => date(r.date) }, { key: 'memo', label: 'Transaction', render: (r) => <span className="link">{r.memo ?? titleCase(r.source_type)}</span> },
          { key: 'reference', label: 'Reference', render: (r) => r.number ?? r.reference ?? '' }, { key: 'contact_name', label: 'Contact' },
          { key: 'debit', label: 'Debit', num: true, render: (r) => (r.debit ? money(r.debit) : '') }, { key: 'credit', label: 'Credit', num: true, render: (r) => (r.credit ? money(r.credit) : '') },
          { key: 'balance', label: 'Balance', num: true, render: (r) => money(r.balance) },
          { key: 'recon_id', label: '', render: (r) => (r.recon_id ? <span className="chip bg-emerald-50 text-emerald-700">Reconciled</span> : '') },
        ]} />
      </div>
    </div>
  );
}

function Journals() {
  const { data, loading } = useApi<any[]>('/journals');
  const nav = useNavigate();
  const can = useCan();
  return (
    <div>
      <PageHeader title="Manual Journals" actions={can('accountant', 'create') && <Link to="/accountant/journals/new" className="btn btn-primary no-underline"><Plus className="h-4 w-4" />New Journal</Link>} />
      <div className="p-5">{loading && !data ? <Spinner /> : (
        <DataTable exportName="manual_journals" rows={data ?? []} onRow={(r) => nav(`/accountant/journals/${r.id}`)} cols={[
          { key: 'date', label: 'Date', render: (r) => date(r.date) }, { key: 'number', label: 'Journal #', render: (r) => <span className="link">{r.number}</span> },
          { key: 'reference', label: 'Reference' }, { key: 'memo', label: 'Notes' }, { key: 'status', label: 'Status', render: (r) => <Badge status={r.status === 'posted' ? 'paid' : 'draft'} label={titleCase(r.status)} /> },
          { key: 'amount', label: 'Amount', num: true, render: (r) => money(r.amount) },
        ]} />
      )}</div>
    </div>
  );
}

function JournalForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const { contacts: customers } = useContacts('customer');
  const { contacts: vendors } = useContacts('vendor');
  const { run, busy } = useAction();
  const [f, setF] = useState<any>(id ? null : { date: today(), lines: [{ debit: '', credit: '' }, { debit: '', credit: '' }] });
  useEffect(() => { if (id) get(`/journals/${id}`).then(setF); }, [id]);
  if (!f) return <Spinner />;
  const upd = (i: number, p: any) => setF({ ...f, lines: f.lines.map((l: any, j: number) => (j === i ? { ...l, ...p } : l)) });
  const dr = f.lines.reduce((a: number, l: any) => a + (Number(l.debit) || 0), 0);
  const cr = f.lines.reduce((a: number, l: any) => a + (Number(l.credit) || 0), 0);
  const contacts = [...customers.map((c) => ({ value: c.id, label: c.name, sub: 'Customer' })), ...vendors.map((c) => ({ value: c.id, label: c.name, sub: 'Vendor' }))];
  const save = async (status: string) => {
    const r = await run(() => (id ? put(`/journals/${id}`, { ...f, status }) : post('/journals', { ...f, status })), 'Journal saved');
    if (r) nav(`/accountant/journals/${r.id}`);
  };
  return (
    <div className="pb-20">
      <PageHeader title={id ? `Edit ${f.number}` : 'New Manual Journal'} back={<Link to="/accountant/journals" className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />Manual Journals</Link>} />
      <div className="space-y-4 p-5">
        <div className="card grid gap-4 p-5 sm:grid-cols-3">
          <Field label="Date" required><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Reference #"><Input value={f.reference ?? ''} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
          <Field label="Notes"><Input value={f.memo ?? ''} onChange={(e) => setF({ ...f, memo: e.target.value })} /></Field>
        </div>
        <div className="card overflow-x-auto p-4">
          <table className="table min-w-[800px]"><thead><tr><th className="w-72">Account</th><th>Description</th><th className="w-56">Contact</th><th className="num w-36">Debits</th><th className="num w-36">Credits</th><th /></tr></thead>
            <tbody>{f.lines.map((l: any, i: number) => (
              <tr key={i}>
                <td><AccountPicker value={l.account_id} onChange={(v) => upd(i, { account_id: v })} /></td>
                <td><Input value={l.description ?? ''} onChange={(e) => upd(i, { description: e.target.value })} /></td>
                <td><Combo options={contacts} value={l.contact_id} onChange={(v) => upd(i, { contact_id: v })} placeholder="Contact (for AR/AP)" /></td>
                <td><Input type="number" className="text-right" value={l.debit ?? ''} onChange={(e) => upd(i, { debit: e.target.value, credit: '' })} aria-label="Debit" /></td>
                <td><Input type="number" className="text-right" value={l.credit ?? ''} onChange={(e) => upd(i, { credit: e.target.value, debit: '' })} aria-label="Credit" /></td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setF({ ...f, lines: f.lines.filter((_: any, j: number) => j !== i) })} aria-label="Remove line"><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={3} className="text-right font-semibold">Total</td><td className="num font-semibold">{money(dr)}</td><td className="num font-semibold">{money(cr)}</td><td /></tr>
              {Math.abs(dr - cr) > 0.004 && <tr><td colSpan={6} className="text-right text-red-600">Difference {money(dr - cr)} — debits must equal credits</td></tr>}</tfoot>
          </table>
          <button className="btn btn-sm mt-2" onClick={() => setF({ ...f, lines: [...f.lines, { debit: '', credit: '' }] })}><Plus className="h-3.5 w-3.5" />Add line</button>
        </div>
      </div>
      <div className="no-print fixed bottom-0 left-0 right-0 flex gap-2 border-t bg-white px-5 py-3 lg:left-60">
        <button className="btn" disabled={busy} onClick={() => save('draft')}>Save as Draft</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => save('posted')}>Save and Publish</button>
        <button className="btn" onClick={() => nav(-1)}>Cancel</button>
      </div>
    </div>
  );
}

function JournalView() {
  const { id } = useParams();
  const { data: j, error, loading } = useApi<any>(`/journals/${id}`);
  const nav = useNavigate();
  const can = useCan();
  const { run } = useAction();
  const [delOpen, setDelOpen] = useState(false);
  if (loading && !j) return <Spinner />;
  if (error || !j) return <div className="p-6"><ErrorBox error={error} /></div>;
  return (
    <div>
      <PageHeader title={`Journal ${j.number}`} subtitle={`${date(j.date)} · ${titleCase(j.status)}`} back={<Link to="/accountant/journals" className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />Manual Journals</Link>}
        actions={<>
          {can('accountant', 'edit') && <Link className="btn no-underline" to={`/accountant/journals/${id}/edit`}>Edit</Link>}
          {can('accountant', 'create') && <button className="btn" onClick={async () => { const r = await run(() => post(`/journals/${id}/reverse`, { date: today() }), 'Reversal created'); if (r) nav(`/accountant/journals/${r.id}`); }}>Reverse</button>}
          <button className="btn" onClick={() => window.print()}>Print</button>
          {can('accountant', 'delete') && <button className="btn" onClick={() => setDelOpen(true)}>Delete</button>}
        </>} />
      <div className="p-5"><div className="card print-area p-5">
        <div className="mb-3 text-[13px]"><b>{j.reference}</b> {j.memo}</div>
        <table className="table"><thead><tr><th>Account</th><th>Description</th><th>Contact</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
          <tbody>{j.lines.map((l: any) => <tr key={l.id}><td>{l.account_name}</td><td>{l.description}</td><td>{l.contact_name}</td><td className="num">{l.debit ? money(l.debit) : ''}</td><td className="num">{l.credit ? money(l.credit) : ''}</td></tr>)}</tbody>
          <tfoot><tr><td colSpan={3} className="font-semibold">Total</td><td className="num font-semibold">{money(j.lines.reduce((a: number, l: any) => a + l.debit, 0))}</td><td className="num font-semibold">{money(j.lines.reduce((a: number, l: any) => a + l.credit, 0))}</td></tr></tfoot></table>
      </div></div>
      {delOpen && <Confirm danger title="Delete journal" message={`Delete ${j.number}?`} confirmLabel="Delete" onClose={() => setDelOpen(false)} onConfirm={async () => { setDelOpen(false); if (await run(() => del(`/journals/${id}`), 'Deleted')) nav('/accountant/journals'); }} />}
    </div>
  );
}

function Budgets() {
  const { data, reload } = useApi<any[]>('/budgets');
  const can = useCan();
  const nav = useNavigate();
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  const fy = Number(today().slice(5, 7)) >= 4 ? Number(today().slice(0, 4)) : Number(today().slice(0, 4)) - 1;
  const open = async (id?: number) => setEdit(id ? await get(`/budgets/${id}`) : { name: '', fiscal_year: fy, lines: [] });
  return (
    <div>
      <PageHeader title="Budgets" subtitle="Monthly budgets by account with budget vs actuals" actions={can('accountant', 'create') && <button className="btn btn-primary" onClick={() => open()}><Plus className="h-4 w-4" />New Budget</button>} />
      <div className="p-5">
        <DataTable rows={data ?? []} onRow={(r) => nav(`/reports/budget/${r.id}`)} cols={[
          { key: 'name', label: 'Budget', render: (r) => <span className="link">{r.name}</span> }, { key: 'fiscal_year', label: 'Fiscal Year', render: (r) => `${r.fiscal_year}-${String((r.fiscal_year + 1) % 100).padStart(2, '0')}` },
          { key: 'edit', label: '', render: (r) => <button className="text-xs text-brand-600" onClick={(e) => { e.stopPropagation(); open(r.id); }}>Edit</button> },
        ]} />
      </div>
      {edit && (
        <Modal wide title={edit.id ? `Edit ${edit.name}` : 'New budget'} onClose={() => setEdit(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (edit.id ? put(`/budgets/${edit.id}`, edit) : post('/budgets', edit)), 'Budget saved')) { setEdit(null); reload(); } }}>Save</button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Fiscal year starting April"><Input type="number" value={edit.fiscal_year} onChange={(e) => setEdit({ ...edit, fiscal_year: Number(e.target.value) })} /></Field>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="table min-w-[1100px]"><thead><tr><th className="w-56">Account</th>{['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'].map((m) => <th key={m} className="num">{m}</th>)}<th /></tr></thead>
              <tbody>{edit.lines.map((l: any, i: number) => (
                <tr key={i}><td><AccountPicker value={l.account_id} onChange={(v) => setEdit({ ...edit, lines: edit.lines.map((x: any, j: number) => (j === i ? { ...x, account_id: v } : x)) })} categories={['income', 'expense']} /></td>
                  {Array.from({ length: 12 }, (_, m) => <td key={m}><input className="input w-20 px-1 text-right text-xs" type="number" value={l.amounts?.[m] ?? ''} onChange={(e) => setEdit({ ...edit, lines: edit.lines.map((x: any, j: number) => (j === i ? { ...x, amounts: Array.from({ length: 12 }, (_, k) => (k === m ? Number(e.target.value) : x.amounts?.[k] ?? 0)) } : x)) })} aria-label="Budget amount" /></td>)}
                  <td><button className="btn btn-ghost btn-sm" onClick={() => setEdit({ ...edit, lines: edit.lines.filter((_: any, j: number) => j !== i) })} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button></td></tr>
              ))}</tbody></table>
            <button className="btn btn-sm mt-2" onClick={() => setEdit({ ...edit, lines: [...edit.lines, { amounts: Array(12).fill(0) }] })}><Plus className="h-3.5 w-3.5" />Add account</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Locking() {
  const { meta, reload } = useMeta();
  const [locks, setLocks] = useState<Record<string, string>>(meta.lock_dates);
  const { run, busy } = useAction();
  const can = useCan();
  const mods = [['sales', 'Sales (quotes, orders, invoices, credit notes, payments received)'], ['purchases', 'Purchases (bills, expenses, vendor credits, payments made)'], ['banking', 'Banking transactions'], ['accountant', 'Manual journals, depreciation'], ['inventory', 'Inventory documents and manufacturing'], ['payroll', 'Pay runs'], ['all', 'Lock everything']];
  return (
    <div>
      <PageHeader title="Transaction Locking" subtitle="Prevent changes to transactions dated on or before the lock date (e.g. after filing returns or closing the books)" />
      <div className="p-5"><div className="card max-w-3xl divide-y divide-slate-100">
        {mods.map(([k, l]) => (
          <div key={k} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div><div className="font-medium">{titleCase(k)}</div><div className="text-xs text-slate-500">{l}</div></div>
            <div className="flex items-center gap-2">
              <Input type="date" className="w-44" value={locks[k] ?? ''} onChange={(e) => setLocks({ ...locks, [k]: e.target.value })} aria-label={`${k} lock date`} />
              {locks[k] && <button className="btn btn-sm" onClick={() => setLocks({ ...locks, [k]: '' })}>Unlock</button>}
            </div>
          </div>
        ))}
        <div className="p-4"><button className="btn btn-primary" disabled={busy || !can('accountant', 'approve')} onClick={async () => { if (await run(() => put('/settings/lock-dates', locks), 'Lock dates saved')) reload(); }}>Save</button></div>
      </div></div>
    </div>
  );
}

export default function Accountant() {
  return (
    <Routes>
      <Route path="accounts" element={<Accounts />} />
      <Route path="accounts/:id" element={<AccountView />} />
      <Route path="journals" element={<Journals />} />
      <Route path="journals/new" element={<JournalForm />} />
      <Route path="journals/:id" element={<JournalView />} />
      <Route path="journals/:id/edit" element={<JournalForm />} />
      <Route path="budgets" element={<Budgets />} />
      <Route path="locking" element={<Locking />} />
      <Route path="*" element={<Accounts />} />
    </Routes>
  );
}
