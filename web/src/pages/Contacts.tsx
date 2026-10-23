import { ArrowLeft, Plus, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { del, get, post, put } from '../api';
import { DataTable } from '../components/DataTable';
import { StateSelect } from '../components/pickers';
import { Badge, Check, Confirm, ErrorBox, Field, Input, KeyVal, PageHeader, Select, Spinner, Stat, Tabs, Textarea, useAction } from '../components/ui';
import { date, money, today } from '../lib/format';
import { useApi, useCan, useDebounced, useMeta } from '../lib/hooks';
import { CustomFieldInputs } from './docs/DocForm';
import { ImportModal } from './Items';

type Kind = 'customer' | 'vendor';
const base = (k: Kind) => (k === 'customer' ? '/customers' : '/vendors');
const label = (k: Kind) => (k === 'customer' ? 'Customer' : 'Vendor');
const mod = (k: Kind) => (k === 'customer' ? 'sales' : 'purchases');

function List({ kind }: { kind: Kind }) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const { data, loading, error, reload } = useApi<any[]>(`/contacts?kind=${kind}&active=all&search=${encodeURIComponent(q)}`);
  const nav = useNavigate();
  const can = useCan();
  const { meta } = useMeta();
  const [imp, setImp] = useState(false);
  return (
    <div>
      <PageHeader title={`${label(kind)}s`} actions={can(mod(kind), 'create') && <><button className="btn" onClick={() => setImp(true)}><Upload className="h-4 w-4" />Import</button><Link to={`${base(kind)}/new`} className="btn btn-primary no-underline"><Plus className="h-4 w-4" />New {label(kind)}</Link></>} />
      <div className="space-y-3 p-5">
        <Input className="w-72" placeholder="Search name, email, GSTIN" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search contacts" />
        <ErrorBox error={error} />
        {loading && !data ? <Spinner /> : (
          <DataTable exportName={`${kind}s`} rows={data ?? []} onRow={(r) => nav(`${base(kind)}/${r.id}`)} cols={[
            { key: 'name', label: 'Name', render: (r) => <span className="link font-medium">{r.name}{!r.is_active && <span className="ml-1 text-xs text-slate-400">(inactive)</span>}</span> },
            { key: 'company_name', label: 'Company' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' },
            { key: 'gst_treatment', label: 'GST Treatment', render: (r) => meta.gst_treatments[r.gst_treatment] },
            { key: 'gstin', label: 'GSTIN' },
            { key: 'balance', label: kind === 'customer' ? 'Receivables' : 'Payables', num: true, render: (r) => money(r.balance) },
          ]} />
        )}
      </div>
      {imp && <ImportModal path={`/contacts/import?kind=${kind}`} onClose={() => setImp(false)} onDone={reload} sample={'name,company_name,email,phone,gst_treatment,gstin,payment_terms\nAcme Traders,Acme Traders,acme@example.com,9800000000,business_gst,27AAPFU0939F1ZV,30'} />}
    </div>
  );
}

function Form({ kind }: { kind: Kind }) {
  const { id } = useParams();
  const nav = useNavigate();
  const { meta } = useMeta();
  const { run, busy } = useAction();
  const [f, setF] = useState<any>(id ? null : { kind, gst_treatment: 'business_gst', payment_terms: 30, currency_code: 'INR', place_of_supply: meta.org.state_code, custom: {} });
  useEffect(() => { if (id) get(`/contacts/${id}`).then(setF); }, [id]);
  if (!f) return <Spinner />;
  const set = (p: any) => setF({ ...f, ...p });
  const registered = ['business_gst', 'business_composition', 'sez', 'deemed_export'].includes(f.gst_treatment);
  const save = async () => {
    const r = await run(() => (id ? put(`/contacts/${id}`, f) : post('/contacts', { ...f, kind })), `${label(kind)} saved`);
    if (r) nav(`${base(kind)}/${r.id}`);
  };
  return (
    <div className="pb-20">
      <PageHeader title={id ? `Edit ${f.name}` : `New ${label(kind)}`} back={<Link to={base(kind)} className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />{label(kind)}s</Link>} />
      <div className="space-y-5 p-5">
        <div className="card grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Display Name" required><Input value={f.name ?? ''} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Company Name"><Input value={f.company_name ?? ''} onChange={(e) => set({ company_name: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={f.email ?? ''} onChange={(e) => set({ email: e.target.value })} /></Field>
          <Field label="Phone"><Input value={f.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} /></Field>
          <Field label="GST Treatment"><Select value={f.gst_treatment} onChange={(e) => set({ gst_treatment: e.target.value })} options={Object.entries(meta.gst_treatments).map(([v, l]) => ({ value: v, label: l }))} /></Field>
          {registered && <Field label="GSTIN" required hint="15 characters; the check digit is validated"><Input value={f.gstin ?? ''} onChange={(e) => set({ gstin: e.target.value.toUpperCase(), place_of_supply: e.target.value.length >= 2 ? e.target.value.slice(0, 2) : f.place_of_supply })} /></Field>}
          {f.gst_treatment !== 'overseas' && <Field label={kind === 'customer' ? 'Place of Supply' : 'Source of Supply'}><StateSelect value={f.place_of_supply} onChange={(v) => set({ place_of_supply: v })} /></Field>}
          <Field label="PAN"><Input value={f.pan ?? ''} onChange={(e) => set({ pan: e.target.value.toUpperCase() })} /></Field>
          <Field label="Currency"><Select value={f.currency_code} onChange={(e) => set({ currency_code: e.target.value })} options={meta.currencies.map((c) => ({ value: c.code, label: `${c.code} - ${c.name}` }))} /></Field>
          <Field label="Payment Terms (days)"><Input type="number" value={f.payment_terms ?? 0} onChange={(e) => set({ payment_terms: Number(e.target.value) })} /></Field>
          {kind === 'customer' && <Field label="Credit Limit (₹)"><Input type="number" value={f.credit_limit ?? ''} onChange={(e) => set({ credit_limit: e.target.value })} /></Field>}
          <Field label="Price List"><Select value={f.price_list_id ?? ''} placeholder="None" onChange={(e) => set({ price_list_id: Number(e.target.value) || null })} options={meta.price_lists.filter((p) => p.kind === (kind === 'customer' ? 'sales' : 'purchase')).map((p) => ({ value: p.id, label: p.name }))} /></Field>
          {kind === 'vendor' && <Field label="Default TDS"><Select value={f.tds_section_id ?? ''} placeholder="None" onChange={(e) => set({ tds_section_id: Number(e.target.value) || null })} options={meta.tds_sections.map((t) => ({ value: t.id, label: `${t.section} - ${t.name} (${t.rate}%)` }))} /></Field>}
          <Field label="Opening Balance (₹)" hint={`As of ${date(meta.org.inventory_start_date)}`}><Input type="number" value={f.opening_balance ?? 0} onChange={(e) => set({ opening_balance: Number(e.target.value) })} /></Field>
        </div>
        <div className="card grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Billing Address"><Textarea value={f.billing_address ?? ''} onChange={(e) => set({ billing_address: e.target.value })} /></Field>
          <Field label="Shipping Address"><Textarea value={f.shipping_address ?? ''} onChange={(e) => set({ shipping_address: e.target.value })} /></Field>
          <Field label="Notes" className="sm:col-span-2"><Textarea value={f.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} /></Field>
          <div className="sm:col-span-2"><CustomFieldInputs module={kind} value={f.custom ?? {}} onChange={(v) => set({ custom: v })} /></div>
          <Check label="Active" checked={f.is_active !== 0 && f.is_active !== false} onChange={(v) => set({ is_active: v })} />
        </div>
      </div>
      <div className="no-print fixed bottom-0 left-0 right-0 flex gap-2 border-t bg-white px-5 py-3 lg:left-60"><button className="btn btn-primary" disabled={busy} onClick={save}>Save</button><button className="btn" onClick={() => nav(-1)}>Cancel</button></div>
    </div>
  );
}

function View({ kind }: { kind: Kind }) {
  const { id } = useParams();
  const { data: c, error, loading } = useApi<any>(`/contacts/${id}`);
  const { meta } = useMeta();
  const nav = useNavigate();
  const can = useCan();
  const [tab, setTab] = useState('overview');
  const [from, setFrom] = useState(`${today().slice(0, 4)}-04-01` > today() ? `${Number(today().slice(0, 4)) - 1}-04-01` : `${today().slice(0, 4)}-04-01`);
  const [to, setTo] = useState(today());
  const { data: stmt } = useApi<any>(tab === 'statement' ? `/contacts/${id}/statement?from=${from}&to=${to}` : null);
  const [delOpen, setDelOpen] = useState(false);
  const { run } = useAction();
  if (loading && !c) return <Spinner />;
  if (error || !c) return <div className="p-6"><ErrorBox error={error} /></div>;
  const newDocs = kind === 'customer' ? [['invoice', 'Invoice'], ['quote', 'Quote'], ['sales_order', 'Sales Order']] : [['bill', 'Bill'], ['purchase_order', 'Purchase Order'], ['expense', 'Expense']];
  return (
    <div>
      <PageHeader title={c.name} subtitle={[c.company_name, c.gstin, meta.gst_treatments[c.gst_treatment]].filter(Boolean).join(' · ')}
        back={<Link to={base(kind)} className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />{label(kind)}s</Link>}
        actions={<>
          {newDocs.map(([t, l]) => <Link key={t} className="btn no-underline" to={`/docs/${t}/new?contact=${c.id}`}>New {l}</Link>)}
          <Link className="btn no-underline" to={`/payments/${kind === 'customer' ? 'received' : 'made'}/new?contact=${c.id}`}>Record Payment</Link>
          {can(mod(kind), 'edit') && <Link to={`${base(kind)}/${id}/edit`} className="btn no-underline">Edit</Link>}
          {can(mod(kind), 'delete') && <button className="btn" onClick={() => setDelOpen(true)}>Delete</button>}
        </>} />
      <div className="px-5 pt-3"><Tabs active={tab} onChange={setTab} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'transactions', label: 'Transactions' }, { key: 'statement', label: 'Statement' }]} /></div>
      <div className="space-y-4 p-5">
        {tab === 'overview' && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label={kind === 'customer' ? 'Outstanding receivables' : 'Outstanding payables'} value={money(c.balance)} tone={c.balance > 0 ? 'warn' : undefined} />
              <Stat label="Unpaid documents" value={money(c.unpaid)} />
              <Stat label="Payment terms" value={`${c.payment_terms} days`} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="card p-4"><h3 className="mb-2">Contact details</h3><KeyVal items={[['Email', c.email], ['Phone', c.phone], ['GSTIN', c.gstin], ['PAN', c.pan], ['Place of supply', c.place_of_supply && `${meta.states[c.place_of_supply]} (${c.place_of_supply})`], ['Currency', c.currency_code], ['Credit limit', c.credit_limit != null ? money(c.credit_limit) : null], ['Opening balance', money(c.opening_balance)]]} /></div>
              <div className="card p-4"><h3 className="mb-2">Addresses</h3><KeyVal items={[['Billing', <span className="whitespace-pre-line">{c.billing_address}</span>], ['Shipping', <span className="whitespace-pre-line">{c.shipping_address}</span>], ['Notes', c.notes]]} /></div>
            </div>
          </>
        )}
        {tab === 'transactions' && (
          <DataTable rows={c.documents} onRow={(r) => nav(`/docs/${r.type}/${r.id}`)} cols={[
            { key: 'date', label: 'Date', render: (r) => date(r.date) }, { key: 'type', label: 'Type', render: (r) => meta.doc_types[r.type]?.label },
            { key: 'number', label: 'Number', render: (r) => <span className="link">{r.number}</span> }, { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
            { key: 'total', label: 'Amount', num: true, render: (r) => money(r.total) }, { key: 'balance', label: 'Balance', num: true, render: (r) => money(r.balance) },
          ]} />
        )}
        {tab === 'statement' && (
          <div className="space-y-3">
            <div className="flex gap-2"><Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" /><Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" /><button className="btn" onClick={() => window.print()}>Print</button></div>
            {stmt && (
              <div className="card print-area p-5">
                <div className="mb-3 flex justify-between"><div><h2>Statement of Accounts</h2><div className="text-xs text-slate-500">{c.name} · {date(from)} to {date(to)}</div></div><div className="text-right text-xs">Opening {money(stmt.opening)}<br />Closing <b>{money(stmt.closing)}</b></div></div>
                <table className="table"><thead><tr><th>Date</th><th>Transaction</th><th>Reference</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
                  <tbody><tr><td>{date(from)}</td><td colSpan={3}>Opening balance</td><td className="num">{money(stmt.opening)}</td></tr>
                    {stmt.rows.map((r: any, i: number) => <tr key={i}><td>{date(r.date)}</td><td>{r.memo}</td><td>{r.reference}</td><td className="num">{money(r.amount)}</td><td className="num">{money(r.balance)}</td></tr>)}</tbody></table>
              </div>
            )}
          </div>
        )}
      </div>
      {delOpen && <Confirm danger title={`Delete ${label(kind).toLowerCase()}`} message={`Delete ${c.name}?`} confirmLabel="Delete" onClose={() => setDelOpen(false)} onConfirm={async () => { setDelOpen(false); if (await run(() => del(`/contacts/${id}`), 'Deleted')) nav(base(kind)); }} />}
    </div>
  );
}

export default function Contacts({ kind }: { kind: Kind }) {
  return (
    <Routes>
      <Route index element={<List kind={kind} />} />
      <Route path="new" element={<Form kind={kind} />} />
      <Route path=":id" element={<View kind={kind} />} />
      <Route path=":id/edit" element={<Form kind={kind} />} />
    </Routes>
  );
}
