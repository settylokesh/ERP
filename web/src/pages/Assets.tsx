import { ArrowLeft, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { get, post, put } from '../api';
import { DataTable } from '../components/DataTable';
import { AccountPicker, Combo, useContacts } from '../components/pickers';
import { Badge, ErrorBox, Field, Input, KeyVal, Modal, PageHeader, Select, Spinner, Stat, Tabs, Textarea, useAction, useToast } from '../components/ui';
import { date, money, today } from '../lib/format';
import { useApi, useCan } from '../lib/hooks';

function List() {
  const { data, loading, reload } = useApi<any[]>('/assets');
  const { data: types, reload: reloadTypes } = useApi<any[]>('/asset-types');
  const nav = useNavigate();
  const can = useCan();
  const [dep, setDep] = useState(false);
  const [upto, setUpto] = useState(today());
  const [typeEdit, setTypeEdit] = useState<any>(null);
  const [tab, setTab] = useState('assets');
  const { run, busy } = useAction();
  const toast = useToast();
  const totals = (data ?? []).reduce((a, x) => ({ cost: a.cost + (x.status !== 'disposed' ? x.cost : 0), acc: a.acc + (x.status !== 'disposed' ? x.accumulated : 0), bv: a.bv + x.book_value }), { cost: 0, acc: 0, bv: 0 });
  return (
    <div>
      <PageHeader title="Fixed Assets" subtitle="Asset register with SLM/WDV depreciation and disposal"
        actions={can('assets', 'create') && <><button className="btn" onClick={() => setDep(true)}>Run Depreciation</button><Link to="/assets/new" className="btn btn-primary no-underline"><Plus className="h-4 w-4" />New Asset</Link></>} />
      <div className="px-5 pt-3"><Tabs active={tab} onChange={setTab} tabs={[{ key: 'assets', label: 'Assets' }, { key: 'types', label: 'Asset Types' }]} /></div>
      <div className="space-y-4 p-5">
        {tab === 'assets' && (
          <>
            <div className="grid gap-3 sm:grid-cols-3"><Stat label="Gross block" value={money(totals.cost)} /><Stat label="Accumulated depreciation" value={money(totals.acc)} /><Stat label="Net book value" value={money(totals.bv)} /></div>
            {loading && !data ? <Spinner /> : (
              <DataTable exportName="fixed_assets" rows={data ?? []} onRow={(r) => nav(`/assets/${r.id}`)} cols={[
                { key: 'number', label: 'Asset #', render: (r) => <span className="link">{r.number}</span> }, { key: 'name', label: 'Name' }, { key: 'type_name', label: 'Type' },
                { key: 'purchase_date', label: 'Acquired', render: (r) => date(r.purchase_date) }, { key: 'method', label: 'Method', render: (r) => r.method.toUpperCase() },
                { key: 'cost', label: 'Cost', num: true, render: (r) => money(r.cost) }, { key: 'accumulated', label: 'Depreciation', num: true, render: (r) => money(r.accumulated) },
                { key: 'book_value', label: 'Book Value', num: true, render: (r) => money(r.book_value) }, { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
              ]} />
            )}
          </>
        )}
        {tab === 'types' && (
          <>
            {can('assets', 'create') && <button className="btn" onClick={() => setTypeEdit({ method: 'slm', useful_life_months: 60, wdv_rate: 0 })}><Plus className="h-4 w-4" />New Asset Type</button>}
            <DataTable rows={types ?? []} onRow={(r) => setTypeEdit(r)} cols={[{ key: 'name', label: 'Name', render: (r) => <span className="link">{r.name}</span> }, { key: 'method', label: 'Method', render: (r) => r.method.toUpperCase() }, { key: 'useful_life_months', label: 'Useful life (months)', num: true }, { key: 'wdv_rate', label: 'WDV rate %', num: true }]} />
          </>
        )}
      </div>
      {dep && (
        <Modal title="Run depreciation" onClose={() => setDep(false)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => post('/assets/depreciate', { upto })); if (r) { setDep(false); reload(); toast('success', `${r.posted} depreciation entr${r.posted === 1 ? 'y' : 'ies'} posted`); } }}>Post depreciation</button>}>
          <Field label="Post monthly depreciation up to" hint="Months already posted are skipped."><Input type="date" value={upto} onChange={(e) => setUpto(e.target.value)} /></Field>
        </Modal>
      )}
      {typeEdit && (
        <Modal title={typeEdit.id ? 'Edit asset type' : 'New asset type'} onClose={() => setTypeEdit(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (typeEdit.id ? put(`/asset-types/${typeEdit.id}`, typeEdit) : post('/asset-types', typeEdit)), 'Saved')) { setTypeEdit(null); reloadTypes(); } }}>Save</button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2"><Input value={typeEdit.name ?? ''} onChange={(e) => setTypeEdit({ ...typeEdit, name: e.target.value })} /></Field>
            <Field label="Asset account"><AccountPicker value={typeEdit.asset_account_id} onChange={(v) => setTypeEdit({ ...typeEdit, asset_account_id: v })} types={['fixed_asset']} /></Field>
            <Field label="Accumulated depreciation account"><AccountPicker value={typeEdit.accumulated_account_id} onChange={(v) => setTypeEdit({ ...typeEdit, accumulated_account_id: v })} types={['fixed_asset']} /></Field>
            <Field label="Depreciation expense account"><AccountPicker value={typeEdit.depreciation_account_id} onChange={(v) => setTypeEdit({ ...typeEdit, depreciation_account_id: v })} categories={['expense']} /></Field>
            <Field label="Method"><Select value={typeEdit.method} onChange={(e) => setTypeEdit({ ...typeEdit, method: e.target.value })} options={[{ value: 'slm', label: 'Straight line' }, { value: 'wdv', label: 'Written down value' }]} /></Field>
            <Field label="Useful life (months)"><Input type="number" value={typeEdit.useful_life_months} onChange={(e) => setTypeEdit({ ...typeEdit, useful_life_months: Number(e.target.value) })} /></Field>
            <Field label="WDV rate % per year"><Input type="number" value={typeEdit.wdv_rate} onChange={(e) => setTypeEdit({ ...typeEdit, wdv_rate: Number(e.target.value) })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Form() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: types } = useApi<any[]>('/asset-types');
  const { contacts: vendors } = useContacts('vendor');
  const { run, busy } = useAction();
  const [f, setF] = useState<any>(id ? null : { purchase_date: today(), salvage_value: 0 });
  useEffect(() => { if (id) get(`/assets/${id}`).then(setF); }, [id]);
  if (!f || !types) return <Spinner />;
  const set = (p: any) => setF({ ...f, ...p });
  const t = types.find((x) => x.id === f.asset_type_id);
  return (
    <div className="pb-20">
      <PageHeader title={id ? `Edit ${f.number}` : 'New Fixed Asset'} back={<Link to="/assets" className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />Fixed Assets</Link>} />
      <div className="p-5"><div className="card grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Asset name" required><Input value={f.name ?? ''} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Asset type" required><Select value={f.asset_type_id ?? ''} placeholder="Select" onChange={(e) => { const tt = types.find((x) => x.id === Number(e.target.value)); set({ asset_type_id: Number(e.target.value), method: tt?.method, useful_life_months: tt?.useful_life_months, wdv_rate: tt?.wdv_rate }); }} options={types.map((x) => ({ value: x.id, label: x.name }))} /></Field>
        <Field label="Serial #"><Input value={f.serial_no ?? ''} onChange={(e) => set({ serial_no: e.target.value })} /></Field>
        <Field label="Purchase date"><Input type="date" value={f.purchase_date} onChange={(e) => set({ purchase_date: e.target.value })} /></Field>
        <Field label="Depreciation start"><Input type="date" value={f.depreciation_start ?? f.purchase_date} onChange={(e) => set({ depreciation_start: e.target.value })} /></Field>
        <Field label="Cost (₹)" required><Input type="number" value={f.cost ?? ''} onChange={(e) => set({ cost: Number(e.target.value) })} /></Field>
        <Field label="Salvage value (₹)"><Input type="number" value={f.salvage_value ?? 0} onChange={(e) => set({ salvage_value: Number(e.target.value) })} /></Field>
        <Field label="Method"><Select value={f.method ?? t?.method ?? 'slm'} onChange={(e) => set({ method: e.target.value })} options={[{ value: 'slm', label: 'Straight line (SLM)' }, { value: 'wdv', label: 'Written down value (WDV)' }]} /></Field>
        {(f.method ?? t?.method) === 'wdv' ? <Field label="WDV rate % per year"><Input type="number" value={f.wdv_rate ?? ''} onChange={(e) => set({ wdv_rate: Number(e.target.value) })} /></Field>
          : <Field label="Useful life (months)"><Input type="number" value={f.useful_life_months ?? ''} onChange={(e) => set({ useful_life_months: Number(e.target.value) })} /></Field>}
        <Field label="Vendor"><Combo options={vendors.map((v) => ({ value: v.id, label: v.name }))} value={f.vendor_id} onChange={(v) => set({ vendor_id: v })} /></Field>
        <Field label="Paid from (post acquisition)" hint="Leave empty if the purchase was already booked via a bill"><AccountPicker value={f.acquisition_account_id} onChange={(v) => set({ acquisition_account_id: v })} placeholder="Already booked" /></Field>
        <Field label="Location"><Input value={f.location ?? ''} onChange={(e) => set({ location: e.target.value })} /></Field>
        <Field label="Notes" className="sm:col-span-2 lg:col-span-3"><Textarea value={f.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div></div>
      <div className="no-print fixed bottom-0 left-0 right-0 flex gap-2 border-t bg-white px-5 py-3 lg:left-60"><button className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => (id ? put(`/assets/${id}`, f) : post('/assets', f)), 'Asset saved'); if (r) nav(`/assets/${r.id}`); }}>Save as Draft</button><button className="btn" onClick={() => nav(-1)}>Cancel</button></div>
    </div>
  );
}

function View() {
  const { id } = useParams();
  const { data: a, error, loading, setData } = useApi<any>(`/assets/${id}`);
  const [dispose, setDispose] = useState<any>(null);
  const { run, busy } = useAction();
  if (loading && !a) return <Spinner />;
  if (error || !a) return <div className="p-6"><ErrorBox error={error} /></div>;
  return (
    <div>
      <PageHeader title={`${a.number} · ${a.name}`} subtitle={<Badge status={a.status} />} back={<Link to="/assets" className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />Fixed Assets</Link>}
        actions={<>
          {a.status === 'draft' && <><Link className="btn no-underline" to={`/assets/${id}/edit`}>Edit</Link><button className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => post(`/assets/${id}/register`), 'Asset registered'); if (r) setData(r); }}>Register</button></>}
          {['active', 'fully_depreciated'].includes(a.status) && <button className="btn" onClick={() => setDispose({ date: today(), amount: 0 })}>Sell / Dispose</button>}
        </>} />
      <div className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-3"><Stat label="Cost" value={money(a.cost)} /><Stat label="Accumulated depreciation" value={money(a.accumulated)} /><Stat label="Book value" value={money(a.book_value)} /></div>
        <div className="card p-4"><KeyVal items={[['Type', a.type_name], ['Method', a.method === 'slm' ? `Straight line over ${a.useful_life_months} months` : `WDV at ${a.wdv_rate}% p.a.`], ['Purchased', date(a.purchase_date)], ['Depreciation from', date(a.depreciation_start)], ['Salvage value', money(a.salvage_value)], ['Serial #', a.serial_no], ['Location', a.location], ['Disposed', a.disposal_date ? `${date(a.disposal_date)} for ${money(a.disposal_amount)}` : null]]} /></div>
        <div className="card overflow-x-auto p-4"><h3 className="mb-2">Depreciation schedule</h3>
          <table className="table"><thead><tr><th>Period</th><th className="num">Depreciation</th><th className="num">Book value</th><th>Status</th></tr></thead>
            <tbody>{a.schedule.slice(0, 120).map((s: any) => <tr key={s.period_end}><td>{s.period_end.slice(0, 7)}</td><td className="num">{money(s.amount)}</td><td className="num">{money(s.book_value)}</td><td>{s.posted ? <Badge status="paid" label="Posted" /> : <span className="text-xs text-slate-400">Scheduled</span>}</td></tr>)}</tbody></table>
        </div>
      </div>
      {dispose && (
        <Modal title="Sell or dispose asset" onClose={() => setDispose(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => post(`/assets/${id}/dispose`, dispose), 'Asset disposed'); if (r) { setData(r); setDispose(null); } }}>Dispose</button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date"><Input type="date" value={dispose.date} onChange={(e) => setDispose({ ...dispose, date: e.target.value })} /></Field>
            <Field label="Sale amount (0 if scrapped)"><Input type="number" value={dispose.amount} onChange={(e) => setDispose({ ...dispose, amount: Number(e.target.value) })} /></Field>
            {dispose.amount > 0 && <Field label="Received into" className="sm:col-span-2"><AccountPicker value={dispose.account_id} onChange={(v) => setDispose({ ...dispose, account_id: v })} types={['bank', 'cash', 'accounts_receivable', 'other_current_asset']} /></Field>}
          </div>
          <p className="mt-2 text-xs text-slate-500">Gain or loss against book value {money(a.book_value)} posts to "Gain/Loss on Asset Disposal".</p>
        </Modal>
      )}
    </div>
  );
}

export default function Assets() {
  return (
    <Routes>
      <Route index element={<List />} />
      <Route path="new" element={<Form />} />
      <Route path=":id" element={<View />} />
      <Route path=":id/edit" element={<Form />} />
    </Routes>
  );
}
