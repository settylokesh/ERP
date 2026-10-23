import { ArrowLeft, Pause, Play, Plus, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { del, get, post, put } from '../api';
import { DataTable } from '../components/DataTable';
import { Combo, EmployeeSelect, ItemPicker, WarehouseSelect } from '../components/pickers';
import { Badge, Check, Confirm, ErrorBox, Field, Input, KeyVal, Modal, PageHeader, Select, Spinner, Stat, Tabs, Textarea, useAction } from '../components/ui';
import { date, money, qty, titleCase, today } from '../lib/format';
import { useApi, useCan } from '../lib/hooks';

const back = (to: string, label: string) => <Link to={to} className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />{label}</Link>;

// ---------------- Work centres ----------------
function WorkCenters() {
  const { data, reload } = useApi<any[]>('/manufacturing/work-centers');
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  const can = useCan();
  return (
    <div>
      <PageHeader title="Work Centres" subtitle="Machines, lines and stations with hourly cost and daily capacity" actions={can('manufacturing', 'create') && <button className="btn btn-primary" onClick={() => setEdit({ cost_per_hour: 0, capacity_hours: 8 })}><Plus className="h-4 w-4" />New Work Centre</button>} />
      <div className="p-5">
        <DataTable rows={data ?? []} onRow={(r) => setEdit(r)} cols={[
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Name', render: (r) => <span className="link">{r.name}</span> },
          { key: 'cost_per_hour', label: 'Cost / hour', num: true, render: (r) => money(r.cost_per_hour) }, { key: 'capacity_hours', label: 'Capacity (h/day)', num: true },
          { key: 'pending_mos', label: 'Pending MOs', num: true }, { key: 'active_job_cards', label: 'Active job cards', num: true },
          { key: 'load_minutes', label: 'Open load (h)', num: true, render: (r) => qty(r.load_minutes / 60) }, { key: 'completed_mos', label: 'Completed MOs', num: true },
        ]} />
      </div>
      {edit && (
        <Modal title={edit.id ? 'Edit work centre' : 'New work centre'} onClose={() => setEdit(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (edit.id ? put(`/manufacturing/work-centers/${edit.id}`, edit) : post('/manufacturing/work-centers', edit)), 'Saved')) { setEdit(null); reload(); } }}>Save</button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Code"><Input value={edit.code ?? ''} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
            <Field label="Cost per hour (₹)"><Input type="number" value={edit.cost_per_hour} onChange={(e) => setEdit({ ...edit, cost_per_hour: Number(e.target.value) })} /></Field>
            <Field label="Capacity (hours per day)"><Input type="number" value={edit.capacity_hours} onChange={(e) => setEdit({ ...edit, capacity_hours: Number(e.target.value) })} /></Field>
            <Field label="Description" className="sm:col-span-2"><Textarea value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------- BOMs ----------------
function Boms() {
  const { data } = useApi<any[]>('/manufacturing/boms');
  const nav = useNavigate();
  const can = useCan();
  return (
    <div>
      <PageHeader title="Bills of Materials" subtitle="Components, operations and overheads for each finished item" actions={can('manufacturing', 'create') && <Link to="/manufacturing/boms/new" className="btn btn-primary no-underline"><Plus className="h-4 w-4" />New BOM</Link>} />
      <div className="p-5"><DataTable rows={data ?? []} onRow={(r) => nav(`/manufacturing/boms/${r.id}`)} cols={[
        { key: 'number', label: 'BOM #', render: (r) => <span className="link">{r.number}</span> }, { key: 'name', label: 'Name' }, { key: 'item_name', label: 'Finished item' },
        { key: 'quantity', label: 'Output qty', num: true }, { key: 'components', label: 'Components', num: true },
        { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> }, { key: 'is_default', label: 'Default', render: (r) => (r.is_default ? 'Yes' : '') },
      ]} /></div>
    </div>
  );
}

function BomForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: wcs } = useApi<any[]>('/manufacturing/work-centers');
  const { run, busy } = useAction();
  const [f, setF] = useState<any>(id && id !== 'new' ? null : { quantity: 1, overhead_cost: 0, components: [{ qty: 1, wastage_pct: 0 }], operations: [], is_default: true, status: 'active' });
  const [view, setView] = useState<any>(null);
  useEffect(() => { if (id && id !== 'new') get(`/manufacturing/boms/${id}`).then((b) => { setF(b); setView(b); }); }, [id]);
  if (!f) return <Spinner />;
  const set = (p: any) => setF({ ...f, ...p });
  const updC = (i: number, p: any) => set({ components: f.components.map((c: any, j: number) => (j === i ? { ...c, ...p } : c)) });
  const updO = (i: number, p: any) => set({ operations: f.operations.map((c: any, j: number) => (j === i ? { ...c, ...p } : c)) });
  return (
    <div className="pb-20">
      <PageHeader title={view ? `${view.number} · ${view.name}` : 'New Bill of Materials'} back={back('/manufacturing/boms', 'Bills of Materials')}
        actions={view && <Link className="btn btn-primary no-underline" to={`/manufacturing/orders/new?bom=${view.id}`}>New Manufacturing Order</Link>} />
      <div className="space-y-4 p-5">
        {view && <div className="grid gap-3 sm:grid-cols-4"><Stat label="Material cost" value={money(view.cost.material)} /><Stat label="Labour cost" value={money(view.cost.labour)} /><Stat label="Overhead" value={money(view.cost.overhead)} /><Stat label={`Cost per ${view.unit ?? 'unit'}`} value={money(view.cost.per_unit)} sub={`for ${view.quantity} unit(s): ${money(view.cost.total)}`} /></div>}
        <div className="card grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Finished item" required className="sm:col-span-2"><ItemPicker value={f.item_id} onChange={(v) => set({ item_id: v })} filter={(i) => i.type === 'goods' && i.track_inventory} /></Field>
          <Field label="BOM name"><Input value={f.name ?? ''} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Output quantity"><Input type="number" value={f.quantity} onChange={(e) => set({ quantity: Number(e.target.value) })} /></Field>
          <Field label="Overhead cost per batch (₹)"><Input type="number" value={f.overhead_cost} onChange={(e) => set({ overhead_cost: Number(e.target.value) })} /></Field>
          <Field label="Status"><Select value={f.status} onChange={(e) => set({ status: e.target.value })} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} /></Field>
          <div className="pt-6"><Check label="Default BOM for this item" checked={!!f.is_default} onChange={(v) => set({ is_default: v })} /></div>
        </div>
        <div className="card overflow-x-auto p-4"><h3 className="mb-2">Components</h3>
          <table className="table min-w-[640px]"><thead><tr><th>Item</th><th className="num w-32">Quantity</th><th className="num w-32">Wastage %</th>{view && <th className="num">Unit cost</th>}<th /></tr></thead>
            <tbody>{f.components.map((c: any, i: number) => <tr key={i}><td><ItemPicker value={c.item_id} onChange={(v) => updC(i, { item_id: v })} filter={(x) => x.type === 'goods'} /></td>
              <td><Input aria-label={`Component ${i + 1} quantity`} type="number" className="text-right" value={c.qty} onChange={(e) => updC(i, { qty: Number(e.target.value) })} /></td>
              <td><Input aria-label={`Component ${i + 1} wastage %`} type="number" className="text-right" value={c.wastage_pct} onChange={(e) => updC(i, { wastage_pct: Number(e.target.value) })} /></td>
              {view && <td className="num">{money(view.components.find((x: any) => x.item_id === c.item_id)?.avg_cost ?? view.components.find((x: any) => x.item_id === c.item_id)?.purchase_rate)}</td>}
              <td><button className="btn btn-ghost btn-sm" onClick={() => set({ components: f.components.filter((_: any, j: number) => j !== i) })} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button></td></tr>)}</tbody></table>
          <button className="btn btn-sm mt-2" onClick={() => set({ components: [...f.components, { qty: 1, wastage_pct: 0 }] })}><Plus className="h-3.5 w-3.5" />Add component</button>
        </div>
        <div className="card overflow-x-auto p-4"><h3 className="mb-2">Operations (routing)</h3>
          <table className="table min-w-[640px]"><thead><tr><th className="w-10">Seq</th><th>Operation</th><th>Work centre</th><th className="num w-32">Minutes</th><th /></tr></thead>
            <tbody>{f.operations.map((o: any, i: number) => <tr key={i}><td className="pt-3">{i + 1}</td><td><Input aria-label={`Operation ${i + 1} name`} value={o.name ?? ''} onChange={(e) => updO(i, { name: e.target.value })} /></td>
              <td><Select aria-label={`Operation ${i + 1} work centre`} value={o.work_center_id ?? ''} placeholder="Select" onChange={(e) => updO(i, { work_center_id: Number(e.target.value) })} options={(wcs ?? []).map((w) => ({ value: w.id, label: w.name }))} /></td>
              <td><Input aria-label={`Operation ${i + 1} minutes`} type="number" className="text-right" value={o.minutes ?? 0} onChange={(e) => updO(i, { minutes: Number(e.target.value) })} /></td>
              <td><button className="btn btn-ghost btn-sm" onClick={() => set({ operations: f.operations.filter((_: any, j: number) => j !== i) })} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button></td></tr>)}</tbody></table>
          <button className="btn btn-sm mt-2" onClick={() => set({ operations: [...f.operations, { minutes: 0 }] })}><Plus className="h-3.5 w-3.5" />Add operation</button>
        </div>
      </div>
      <div className="no-print fixed bottom-0 left-0 right-0 flex gap-2 border-t bg-white px-5 py-3 lg:left-60">
        <button className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => (view ? put(`/manufacturing/boms/${view.id}`, f) : post('/manufacturing/boms', f)), 'BOM saved'); if (r) { setF(r); setView(r); nav(`/manufacturing/boms/${r.id}`, { replace: true }); } }}>Save</button>
        {view && <button className="btn" onClick={async () => { if (await run(() => del(`/manufacturing/boms/${view.id}`), 'BOM deleted')) nav('/manufacturing/boms'); }}>Delete</button>}
      </div>
    </div>
  );
}

// ---------------- Manufacturing orders ----------------
function Orders() {
  const [status, setStatus] = useState('');
  const { data } = useApi<any[]>(`/manufacturing/orders?status=${status}`);
  const nav = useNavigate();
  const can = useCan();
  return (
    <div>
      <PageHeader title="Manufacturing Orders" subtitle="Plan production, release job cards, consume materials and receive finished goods" actions={can('manufacturing', 'create') && <Link to="/manufacturing/orders/new" className="btn btn-primary no-underline"><Plus className="h-4 w-4" />New MO</Link>} />
      <div className="space-y-3 p-5">
        <div className="flex gap-1">{['', 'draft', 'confirmed', 'in_progress', 'completed', 'cancelled'].map((s) => <button key={s} className={`chip cursor-pointer px-3 py-1 ${status === s ? 'bg-brand-600 text-white' : 'bg-white ring-1 ring-slate-200'}`} onClick={() => setStatus(s)}>{s ? titleCase(s) : 'All'}</button>)}</div>
        <DataTable exportName="manufacturing_orders" rows={data ?? []} onRow={(r) => nav(`/manufacturing/orders/${r.id}`)} cols={[
          { key: 'date', label: 'Date', render: (r) => date(r.date) }, { key: 'number', label: 'MO #', render: (r) => <span className="link">{r.number}</span> },
          { key: 'item_name', label: 'Item' }, { key: 'qty', label: 'Quantity', num: true, render: (r) => `${qty(r.qty)} ${r.unit}` },
          { key: 'produced_qty', label: 'Produced', num: true, render: (r) => (r.status === 'completed' ? qty(r.produced_qty) : '-') },
          { key: 'job_cards', label: 'Job cards', render: (r) => `${r.job_cards_done}/${r.job_cards}` }, { key: 'warehouse_name', label: 'Warehouse' },
          { key: 'planned_start', label: 'Planned start', render: (r) => date(r.planned_start) }, { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
        ]} />
      </div>
    </div>
  );
}

function OrderForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: boms } = useApi<any[]>('/manufacturing/boms');
  const { run, busy } = useAction();
  const params = new URLSearchParams(window.location.search);
  const [f, setF] = useState<any>(id ? null : { date: today(), planned_start: today(), qty: 1, bom_id: params.get('bom') ? Number(params.get('bom')) : null });
  useEffect(() => { if (id) get(`/manufacturing/orders/${id}`).then(setF); }, [id]);
  if (!f) return <Spinner />;
  const set = (p: any) => setF({ ...f, ...p });
  return (
    <div className="pb-20">
      <PageHeader title={id ? `Edit ${f.number}` : 'New Manufacturing Order'} back={back('/manufacturing/orders', 'Manufacturing Orders')} />
      <div className="p-5"><div className="card grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Bill of materials" required className="sm:col-span-2"><Combo options={(boms ?? []).filter((b) => b.status === 'active').map((b) => ({ value: b.id, label: `${b.item_name} — ${b.name}`, sub: b.number }))} value={f.bom_id} onChange={(v) => set({ bom_id: v })} /></Field>
        <Field label="Quantity to manufacture" required><Input type="number" value={f.qty} onChange={(e) => set({ qty: Number(e.target.value) })} /></Field>
        <Field label="Order date"><Input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></Field>
        <Field label="Planned start"><Input type="date" value={f.planned_start ?? ''} onChange={(e) => set({ planned_start: e.target.value })} /></Field>
        <Field label="Planned end"><Input type="date" value={f.planned_end ?? ''} onChange={(e) => set({ planned_end: e.target.value })} /></Field>
        <Field label="Warehouse (components and output)"><WarehouseSelect value={f.warehouse_id} onChange={(v) => set({ warehouse_id: v })} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea value={f.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div></div>
      <div className="no-print fixed bottom-0 left-0 right-0 flex gap-2 border-t bg-white px-5 py-3 lg:left-60"><button className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => (id ? put(`/manufacturing/orders/${id}`, f) : post('/manufacturing/orders', f)), 'Saved'); if (r) nav(`/manufacturing/orders/${r.id}`); }}>Save as Draft</button><button className="btn" onClick={() => nav(-1)}>Cancel</button></div>
    </div>
  );
}

function JobCardButtons({ jc, onDone }: { jc: any; onDone: () => void }) {
  const { run, busy } = useAction();
  const [complete, setComplete] = useState(false);
  const [mins, setMins] = useState('');
  const act = async (a: string, body: any = {}) => { if (await run(() => post(`/manufacturing/job-cards/${jc.id}/${a}`, body), `Job card ${a.replace('_', ' ')}`)) onDone(); };
  if (jc.status === 'completed' || jc.status === 'cancelled') return <Badge status={jc.status} />;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {['pending', 'paused'].includes(jc.status) && <button className="btn btn-sm" disabled={busy} onClick={() => act('start')}><Play className="h-3 w-3" />Start</button>}
      {jc.status === 'in_progress' && <button className="btn btn-sm" disabled={busy} onClick={() => act('pause')}><Pause className="h-3 w-3" />Pause</button>}
      <button className="btn btn-sm" disabled={busy} onClick={() => setComplete(true)}><Square className="h-3 w-3" />Complete</button>
      {complete && (
        <Modal title={`Complete ${jc.number}`} onClose={() => setComplete(false)} footer={<button className="btn btn-primary" onClick={() => { setComplete(false); act('complete', mins ? { minutes: Number(mins) } : {}); }}>Complete</button>}>
          <Field label="Additional minutes to log (optional)" hint={`Planned ${qty(jc.planned_minutes)} min · logged ${qty(jc.actual_minutes)} min. Running timers are stopped automatically.`}><Input type="number" value={mins} onChange={(e) => setMins(e.target.value)} /></Field>
        </Modal>
      )}
    </span>
  );
}

function CompleteMo({ mo, onClose, onDone }: { mo: any; onClose: () => void; onDone: (m: any) => void }) {
  const [f, setF] = useState<any>({ date: today(), produced_qty: mo.qty, rejected_qty: 0, auto_complete_job_cards: true, consumption: mo.components.map((c: any) => ({ component_id: c.id, qty: c.required_qty, tracking: [] })), output_tracking: [] });
  const [serials, setSerials] = useState('');
  const [batch, setBatch] = useState({ batch_no: '', expiry_date: '' });
  const { run, busy } = useAction();
  const save = async () => {
    const out = mo.item_tracking === 'serial' ? serials.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map((s) => ({ serial_no: s }))
      : mo.item_tracking === 'batch' ? [{ batch_no: batch.batch_no, qty: f.produced_qty, expiry_date: batch.expiry_date || null }] : [];
    const r = await run(() => post(`/manufacturing/orders/${mo.id}/complete`, { ...f, output_tracking: out }), 'Manufacturing order completed');
    if (r) onDone(r);
  };
  return (
    <Modal wide title={`Complete ${mo.number}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>Complete production</button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Completion date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          {mo.qc_required ? <div className="text-xs text-slate-600 sm:col-span-2">Output quantities come from the quality inspection (accepted vs rejected).</div> : <>
            <Field label="Good quantity produced"><Input type="number" value={f.produced_qty} onChange={(e) => setF({ ...f, produced_qty: Number(e.target.value) })} /></Field>
            <Field label="Rejected / scrap quantity"><Input type="number" value={f.rejected_qty} onChange={(e) => setF({ ...f, rejected_qty: Number(e.target.value) })} /></Field>
          </>}
        </div>
        <Check label="Auto-complete open job cards at planned time" checked={f.auto_complete_job_cards} onChange={(v) => setF({ ...f, auto_complete_job_cards: v })} />
        <div><h3 className="mb-1">Material consumption</h3>
          <table className="table"><thead><tr><th>Component</th><th className="num">Required</th><th className="num">Available</th><th className="num w-36">Consume</th><th>Batch/Serial</th></tr></thead>
            <tbody>{mo.components.map((c: any, i: number) => (
              <tr key={c.id}><td>{c.item_name}</td><td className="num">{qty(c.required_qty)} {c.unit}</td><td className={`num ${c.shortage > 0 ? 'text-red-600' : ''}`}>{qty(c.on_hand)}</td>
                <td><Input aria-label={`Quantity consumed of ${c.item_name ?? `component ${i + 1}`}`} type="number" className="text-right" value={f.consumption[i].qty} onChange={(e) => setF({ ...f, consumption: f.consumption.map((x: any, j: number) => (j === i ? { ...x, qty: Number(e.target.value) } : x)) })} /></td>
                <td>{c.tracking === 'serial' ? <Input aria-label="Serial numbers" placeholder="Serials, comma separated" onChange={(e) => setF({ ...f, consumption: f.consumption.map((x: any, j: number) => (j === i ? { ...x, tracking: e.target.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ serial_no: s })) } : x)) })} />
                  : c.tracking === 'batch' ? <span className="text-xs text-slate-500">Auto-allocated by earliest expiry</span> : '-'}</td></tr>
            ))}</tbody></table>
        </div>
        {mo.item_tracking === 'serial' && <Field label="Serial numbers of finished units"><Textarea value={serials} onChange={(e) => setSerials(e.target.value)} placeholder="One per line" /></Field>}
        {mo.item_tracking === 'batch' && <div className="grid gap-3 sm:grid-cols-2"><Field label="Output batch #"><Input value={batch.batch_no} onChange={(e) => setBatch({ ...batch, batch_no: e.target.value })} /></Field><Field label="Expiry"><Input type="date" value={batch.expiry_date} onChange={(e) => setBatch({ ...batch, expiry_date: e.target.value })} /></Field></div>}
      </div>
    </Modal>
  );
}

function InspectionModal({ inspectionId, onClose, onDone }: { inspectionId: number; onClose: () => void; onDone: () => void }) {
  const { data: qi } = useApi<any>(`/manufacturing/inspections/${inspectionId}`);
  const [f, setF] = useState<any>({ results: {} });
  const { run, busy } = useAction();
  if (!qi) return null;
  const accepted = f.accepted_qty ?? qi.qty;
  return (
    <Modal wide title={`Quality inspection ${qi.number} — ${qi.item_name}`} onClose={onClose}
      footer={qi.status === 'pending' && <button className="btn btn-primary" disabled={busy} onClick={async () => {
        const results = qi.parameters.map((p: any) => ({ parameter: p.name, value: f.results[p.name]?.value, pass: f.results[p.name]?.pass ?? false }));
        if (await run(() => post(`/manufacturing/inspections/${inspectionId}/record`, { accepted_qty: accepted, rejected_qty: qi.qty - accepted, results, inspector: f.inspector, notes: f.notes }), 'Inspection recorded')) onDone();
      }}>Record result</button>}>
      {qi.status !== 'pending' ? (
        <div className="space-y-2"><KeyVal items={[['Status', <Badge status={qi.status} />], ['Accepted', qty(qi.accepted_qty)], ['Rejected', qty(qi.rejected_qty)], ['Inspector', qi.inspector], ['Notes', qi.notes]]} />
          <table className="table"><tbody>{qi.results.map((r: any) => <tr key={r.parameter}><td>{r.parameter}</td><td>{r.value ?? ''}</td><td><Badge status={r.pass ? 'passed' : 'failed'} /></td></tr>)}</tbody></table></div>
      ) : (
        <div className="space-y-3">
          <table className="table"><thead><tr><th>Parameter</th><th>Specification</th><th>Observed</th><th>Pass</th></tr></thead>
            <tbody>{qi.parameters.map((p: any) => (
              <tr key={p.name}><td>{p.name}</td><td>{p.type === 'numeric' ? `${p.min ?? '-'} to ${p.max ?? '-'}` : 'Pass / fail'}</td>
                <td>{p.type === 'numeric' && <Input aria-label={`${p.name} reading`} type="number" value={f.results[p.name]?.value ?? ''} onChange={(e) => setF({ ...f, results: { ...f.results, [p.name]: { ...f.results[p.name], value: e.target.value } } })} />}</td>
                <td>{p.type !== 'numeric' ? <Check label="" checked={!!f.results[p.name]?.pass} onChange={(v) => setF({ ...f, results: { ...f.results, [p.name]: { pass: v } } })} /> : <span className="text-xs text-slate-500">auto</span>}</td></tr>
            ))}</tbody></table>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={`Accepted (of ${qi.qty})`}><Input type="number" value={accepted} onChange={(e) => setF({ ...f, accepted_qty: Number(e.target.value) })} /></Field>
            <Field label="Rejected"><Input disabled value={qi.qty - accepted} /></Field>
            <Field label="Inspector"><Input value={f.inspector ?? ''} onChange={(e) => setF({ ...f, inspector: e.target.value })} /></Field>
          </div>
          <Field label="Notes"><Textarea value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </div>
      )}
    </Modal>
  );
}

function OrderView() {
  const { id } = useParams();
  const { data: mo, error, loading, reload, setData } = useApi<any>(`/manufacturing/orders/${id}`);
  const [complete, setComplete] = useState(false);
  const [inspect, setInspect] = useState<number | null>(null);
  const [tab, setTab] = useState('overview');
  const [cancel, setCancel] = useState(false);
  const { run, busy } = useAction();
  const nav = useNavigate();
  if (loading && !mo) return <Spinner />;
  if (error || !mo) return <div className="p-6"><ErrorBox error={error} /></div>;
  const shortages = mo.components.filter((c: any) => c.shortage > 0);
  return (
    <div>
      <PageHeader title={<span className="flex items-center gap-2">{mo.number}<Badge status={mo.status} /></span>} subtitle={`${qty(mo.qty)} ${mo.unit} of ${mo.item_name} · BOM ${mo.bom_number}${mo.sales_order_number ? ` · for ${mo.sales_order_number}` : ''}`} back={back('/manufacturing/orders', 'Manufacturing Orders')}
        actions={<>
          {mo.status === 'draft' && <><Link className="btn no-underline" to={`/manufacturing/orders/${id}/edit`}>Edit</Link><button className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => post(`/manufacturing/orders/${id}/confirm`), 'Released to the shop floor'); if (r) setData(r.order); }}>Confirm & Release</button></>}
          {['confirmed', 'in_progress'].includes(mo.status) && mo.qc_required && !mo.inspections.some((q: any) => q.status !== 'pending') && <button className="btn" disabled={busy} onClick={async () => { const r = await run(() => post('/manufacturing/inspections', { source_type: 'mo', source_id: mo.id, qty: mo.qty })); if (r) { setInspect(r.id); reload(); } }}>Raise Inspection</button>}
          {['confirmed', 'in_progress'].includes(mo.status) && <button className="btn btn-primary" onClick={() => setComplete(true)}>Complete</button>}
          {['draft', 'confirmed', 'in_progress'].includes(mo.status) && <button className="btn" onClick={() => setCancel(true)}>Cancel</button>}
          {['draft', 'cancelled'].includes(mo.status) && <button className="btn" onClick={async () => { if (await run(() => del(`/manufacturing/orders/${id}`), 'Deleted')) nav('/manufacturing/orders'); }}>Delete</button>}
        </>} />
      <div className="px-5 pt-3"><Tabs active={tab} onChange={setTab} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'jobs', label: `Job Cards (${mo.job_cards.length})` }, { key: 'quality', label: `Quality (${mo.inspections.length})` }, { key: 'journal', label: 'Costing & Journal' }]} /></div>
      <div className="space-y-4 p-5">
        {tab === 'overview' && (
          <>
            {shortages.length > 0 && mo.status !== 'completed' && <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800">Material shortage: {shortages.map((s: any) => `${s.item_name} (${qty(s.shortage)} ${s.unit})`).join(', ')}. <Link to={`/docs/purchase_order/new`}>Create purchase order</Link></p>}
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Planned" value={`${qty(mo.qty)} ${mo.unit}`} sub={`${date(mo.planned_start)} → ${date(mo.planned_end)}`} />
              <Stat label="Produced" value={qty(mo.produced_qty)} sub={mo.rejected_qty ? `${qty(mo.rejected_qty)} rejected` : undefined} />
              <Stat label="Total cost" value={money(mo.cost.total)} />
              <Stat label="Cost per unit" value={money(mo.cost.per_unit)} />
            </div>
            <div className="card overflow-x-auto p-4"><h3 className="mb-2">Components</h3>
              <table className="table"><thead><tr><th>Item</th><th className="num">Required</th><th className="num">Consumed</th><th className="num">On hand</th><th className="num">Reserved by other MOs</th><th className="num">Shortage</th></tr></thead>
                <tbody>{mo.components.map((c: any) => <tr key={c.id}><td>{c.item_name}</td><td className="num">{qty(c.required_qty)} {c.unit}</td><td className="num">{qty(c.consumed_qty)}</td><td className="num">{qty(c.on_hand)}</td><td className="num">{qty(c.reserved_elsewhere)}</td><td className={`num ${c.shortage > 0 ? 'font-medium text-red-600' : ''}`}>{qty(c.shortage)}</td></tr>)}</tbody></table>
            </div>
            <div className="card p-4"><KeyVal items={[['Warehouse', mo.warehouse_name], ['Order date', date(mo.date)], ['Completed on', date(mo.completed_date)], ['Notes', mo.notes]]} /></div>
          </>
        )}
        {tab === 'jobs' && (
          <DataTable rows={mo.job_cards} cols={[
            { key: 'seq', label: '#' }, { key: 'number', label: 'Job card' }, { key: 'name', label: 'Operation' }, { key: 'work_center_name', label: 'Work centre' },
            { key: 'employee_name', label: 'Assigned to' }, { key: 'planned_minutes', label: 'Planned min', num: true, render: (r) => qty(r.planned_minutes) },
            { key: 'actual_minutes', label: 'Actual min', num: true, render: (r) => qty(r.actual_minutes) }, { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
            { key: 'act', label: '', render: (r) => <JobCardButtons jc={r} onDone={reload} /> },
          ]} empty={<div className="p-6 text-center text-slate-500">Job cards are created when the order is confirmed.</div>} />
        )}
        {tab === 'quality' && (
          <DataTable rows={mo.inspections} onRow={(r) => setInspect(r.id)} cols={[{ key: 'number', label: 'Inspection', render: (r) => <span className="link">{r.number}</span> }, { key: 'qty', label: 'Qty', num: true }, { key: 'accepted_qty', label: 'Accepted', num: true }, { key: 'rejected_qty', label: 'Rejected', num: true }, { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> }]}
            empty={<div className="p-6 text-center text-slate-500">{mo.qc_required ? 'This item requires an inspection before completion.' : 'No quality rules apply to this item.'}</div>} />
        )}
        {tab === 'journal' && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card p-4"><h3 className="mb-2">Cost breakdown</h3><KeyVal items={[['Material', money(mo.cost.material)], ['Labour (work centres)', money(mo.cost.labour)], ['Overhead', money(mo.cost.overhead)], ['Total', <b>{money(mo.cost.total)}</b>], ['Per good unit', money(mo.cost.per_unit)]]} /></div>
            <div className="card p-4"><h3 className="mb-2">Journal</h3>{mo.journal.length === 0 ? <div className="text-slate-500">Posted on completion.</div> : <table className="table"><tbody>{mo.journal.map((j: any, i: number) => <tr key={i}><td>{j.account_name}</td><td className="num">{j.debit ? money(j.debit) : ''}</td><td className="num">{j.credit ? money(j.credit) : ''}</td></tr>)}</tbody></table>}</div>
          </div>
        )}
      </div>
      {complete && <CompleteMo mo={mo} onClose={() => setComplete(false)} onDone={(m) => { setComplete(false); setData(m); }} />}
      {inspect && <InspectionModal inspectionId={inspect} onClose={() => setInspect(null)} onDone={() => { setInspect(null); reload(); }} />}
      {cancel && <Confirm danger title="Cancel manufacturing order" message={`Cancel ${mo.number}? Open job cards are cancelled.`} confirmLabel="Cancel order" onClose={() => setCancel(false)} onConfirm={async () => { setCancel(false); const r = await run(() => post(`/manufacturing/orders/${id}/cancel`), 'Cancelled'); if (r) setData(r); }} />}
    </div>
  );
}

// ---------------- Shop floor & calendar ----------------
function ShopFloor() {
  const { data, reload } = useApi<any[]>('/manufacturing/shop-floor');
  const [assign, setAssign] = useState<any>(null);
  const { run } = useAction();
  return (
    <div>
      <PageHeader title="Shop Floor" subtitle="Live job cards by work centre — start, pause and complete operations" actions={<button className="btn" onClick={reload}>Refresh</button>} />
      <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
        {(data ?? []).map((w) => (
          <div key={w.id} className="card p-4">
            <div className="mb-2 flex items-center justify-between"><h3>{w.name}</h3><span className="text-xs text-slate-500">{w.job_cards.length} open</span></div>
            {w.job_cards.length === 0 ? <div className="text-xs text-slate-500">Idle</div> : w.job_cards.map((jc: any) => (
              <div key={jc.id} className={`mb-2 rounded-md border p-2 ${jc.status === 'in_progress' ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}>
                <div className="flex items-center justify-between"><Link to={`/manufacturing/orders/${jc.mo_id}`} className="font-medium">{jc.mo_number}</Link><Badge status={jc.status} /></div>
                <div className="text-xs text-slate-600">{jc.name} · {jc.item_name} × {qty(jc.mo_qty)}</div>
                <div className="text-[11px] text-slate-500">Planned {qty(jc.planned_minutes)} min · logged {qty(jc.actual_minutes)} min · {jc.employee_name ? jc.employee_name : <button className="text-brand-600" onClick={() => setAssign(jc)}>assign</button>}</div>
                <div className="mt-1"><JobCardButtons jc={jc} onDone={reload} /></div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {assign && (
        <Modal title={`Assign ${assign.number}`} onClose={() => setAssign(null)}>
          <EmployeeSelect value={assign.employee_id} onChange={async (v) => { if (await run(() => post(`/manufacturing/job-cards/${assign.id}/assign`, { employee_id: v }), 'Assigned')) { setAssign(null); reload(); } }} />
        </Modal>
      )}
    </div>
  );
}

function Calendar() {
  const [start, setStart] = useState(() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); });
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => { const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); }), [start]);
  const { data } = useApi<any[]>(`/manufacturing/calendar?from=${days[0]}&to=${days[6]}`);
  const { data: wcs } = useApi<any[]>('/manufacturing/work-centers');
  const shift = (n: number) => { const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); setStart(d.toISOString().slice(0, 10)); };
  return (
    <div>
      <PageHeader title="Work Centre Calendar" subtitle="Planned job card load against daily capacity" actions={<><button className="btn" onClick={() => shift(-7)}>‹ Prev</button><button className="btn" onClick={() => shift(7)}>Next ›</button></>} />
      <div className="overflow-x-auto p-5">
        <table className="table card min-w-[900px]">
          <thead><tr><th>Work centre</th>{days.map((d) => <th key={d}>{new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })}</th>)}</tr></thead>
          <tbody>{(wcs ?? []).map((w) => (
            <tr key={w.id}><td className="font-medium">{w.name}<div className="text-[11px] text-slate-500">{w.capacity_hours} h/day</div></td>
              {days.map((d) => {
                const jobs = (data ?? []).filter((j) => j.work_center_id === w.id && j.planned_start?.slice(0, 10) === d);
                const load = jobs.reduce((a, j) => a + j.planned_minutes, 0) / 60;
                const over = load > w.capacity_hours;
                return <td key={d} className={over ? 'bg-red-50' : ''}>
                  {jobs.map((j) => <div key={j.id} className="mb-1 rounded bg-brand-50 px-1.5 py-0.5 text-[11px]" title={`${j.name} · ${j.item_name}`}>{j.mo_number} · {qty(j.planned_minutes)}m</div>)}
                  {load > 0 && <div className={`text-[10px] ${over ? 'font-semibold text-red-600' : 'text-slate-500'}`}>{qty(load)}h / {w.capacity_hours}h</div>}
                </td>;
              })}</tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------- Quality ----------------
function Quality() {
  const [tab, setTab] = useState('inspections');
  const { data: inspections, reload } = useApi<any[]>('/manufacturing/inspections');
  const { data: rules, reload: reloadRules } = useApi<any[]>('/manufacturing/quality-rules');
  const [inspect, setInspect] = useState<number | null>(null);
  const [rule, setRule] = useState<any>(null);
  const { run, busy } = useAction();
  return (
    <div>
      <PageHeader title="Quality" subtitle="Inspection rules and results for production and goods receipts" actions={<button className="btn btn-primary" onClick={() => setRule({ applies_to: 'both', parameters: [{ name: '', type: 'pass_fail' }] })}><Plus className="h-4 w-4" />New Quality Rule</button>} />
      <div className="px-5 pt-3"><Tabs active={tab} onChange={setTab} tabs={[{ key: 'inspections', label: 'Inspections' }, { key: 'rules', label: 'Quality Rules' }]} /></div>
      <div className="p-5">
        {tab === 'inspections' ? (
          <DataTable rows={inspections ?? []} onRow={(r) => setInspect(r.id)} cols={[
            { key: 'number', label: 'Inspection', render: (r) => <span className="link">{r.number}</span> }, { key: 'date', label: 'Date', render: (r) => date(r.date) },
            { key: 'source_number', label: 'Source', render: (r) => <span>{r.source_number} <span className="text-xs text-slate-500">({r.source_type === 'mo' ? 'MO' : 'GRN'})</span></span> },
            { key: 'item_name', label: 'Item' }, { key: 'qty', label: 'Qty', num: true }, { key: 'accepted_qty', label: 'Accepted', num: true }, { key: 'rejected_qty', label: 'Rejected', num: true },
            { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
          ]} />
        ) : (
          <DataTable rows={rules ?? []} onRow={(r) => setRule(r)} cols={[{ key: 'name', label: 'Rule', render: (r) => <span className="link">{r.name}</span> }, { key: 'item_name', label: 'Item' }, { key: 'applies_to', label: 'Applies to', render: (r) => titleCase(r.applies_to) }, { key: 'p', label: 'Parameters', render: (r) => r.parameters.map((p: any) => p.name).join(', ') }]} />
        )}
      </div>
      {inspect && <InspectionModal inspectionId={inspect} onClose={() => setInspect(null)} onDone={() => { setInspect(null); reload(); }} />}
      {rule && (
        <Modal wide title={rule.id ? 'Edit quality rule' : 'New quality rule'} onClose={() => setRule(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (rule.id ? put(`/manufacturing/quality-rules/${rule.id}`, rule) : post('/manufacturing/quality-rules', rule)), 'Rule saved')) { setRule(null); reloadRules(); } }}>Save</button>}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Item"><ItemPicker value={rule.item_id} onChange={(v) => setRule({ ...rule, item_id: v })} filter={(i) => i.type === 'goods'} /></Field>
            <Field label="Rule name"><Input value={rule.name ?? ''} onChange={(e) => setRule({ ...rule, name: e.target.value })} /></Field>
            <Field label="Applies to"><Select value={rule.applies_to} onChange={(e) => setRule({ ...rule, applies_to: e.target.value })} options={[{ value: 'both', label: 'Production and receipts' }, { value: 'manufacturing', label: 'Production only' }, { value: 'purchase_receive', label: 'Purchase receipts only' }]} /></Field>
          </div>
          <table className="table mt-3"><thead><tr><th>Parameter</th><th>Type</th><th>Min</th><th>Max</th><th /></tr></thead>
            <tbody>{rule.parameters.map((p: any, i: number) => {
              const upd = (x: any) => setRule({ ...rule, parameters: rule.parameters.map((q: any, j: number) => (j === i ? { ...q, ...x } : q)) });
              return <tr key={i}><td><Input aria-label="Parameter name" value={p.name} onChange={(e) => upd({ name: e.target.value })} /></td><td><Select aria-label="Parameter type" value={p.type} onChange={(e) => upd({ type: e.target.value })} options={[{ value: 'pass_fail', label: 'Pass / fail' }, { value: 'numeric', label: 'Numeric range' }]} /></td>
                <td>{p.type === 'numeric' && <Input aria-label="Minimum" type="number" value={p.min ?? ''} onChange={(e) => upd({ min: e.target.value })} />}</td><td>{p.type === 'numeric' && <Input aria-label="Maximum" type="number" value={p.max ?? ''} onChange={(e) => upd({ max: e.target.value })} />}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setRule({ ...rule, parameters: rule.parameters.filter((_: any, j: number) => j !== i) })} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button></td></tr>;
            })}</tbody></table>
          <button className="btn btn-sm mt-2" onClick={() => setRule({ ...rule, parameters: [...rule.parameters, { name: '', type: 'pass_fail' }] })}><Plus className="h-3.5 w-3.5" />Add parameter</button>
        </Modal>
      )}
    </div>
  );
}

function Mrp() {
  const { data } = useApi<any[]>('/manufacturing/mrp');
  const nav = useNavigate();
  const { run } = useAction();
  return (
    <div>
      <PageHeader title="Material Requirements Planning" subtitle="Demand from confirmed sales orders and open MOs (plus reorder levels) against stock, open POs and planned output" />
      <div className="p-5">
        <DataTable exportName="mrp" rows={data ?? []} cols={[
          { key: 'name', label: 'Item', render: (r) => <Link to={`/items/${r.item_id}`}>{r.name}</Link> }, { key: 'on_hand', label: 'On hand', num: true, render: (r) => qty(r.on_hand) },
          { key: 'so_demand', label: 'SO demand', num: true, render: (r) => qty(r.so_demand) }, { key: 'mo_demand', label: 'MO demand', num: true, render: (r) => qty(r.mo_demand) },
          { key: 'reorder_level', label: 'Reorder lvl', num: true, render: (r) => qty(r.reorder_level) }, { key: 'po_supply', label: 'On order (PO)', num: true, render: (r) => qty(r.po_supply) },
          { key: 'mo_supply', label: 'Planned output', num: true, render: (r) => qty(r.mo_supply) },
          { key: 'shortage', label: 'Shortage', num: true, render: (r) => <span className={r.shortage > 0 ? 'font-semibold text-red-600' : ''}>{qty(r.shortage)}</span> },
          { key: 'action', label: 'Suggestion', render: (r) => r.action === 'make' ? <button className="btn btn-sm" onClick={async () => { const m = await run(() => post('/manufacturing/orders', { bom_id: r.bom_id, qty: r.shortage }), 'Draft MO created'); if (m) nav(`/manufacturing/orders/${m.id}`); }}>Make {qty(r.shortage)}</button>
            : r.action === 'buy' ? <button className="btn btn-sm" onClick={() => nav(`/docs/purchase_order/new?item=${r.item_id}&qty=${r.shortage}${r.preferred_vendor_id ? `&contact=${r.preferred_vendor_id}` : ''}`)}>Buy {qty(r.shortage)}</button> : <span className="text-xs text-emerald-700">Covered</span> },
        ]} />
      </div>
    </div>
  );
}

export default function Manufacturing() {
  return (
    <Routes>
      <Route path="work-centers" element={<WorkCenters />} />
      <Route path="boms" element={<Boms />} />
      <Route path="boms/new" element={<BomForm />} />
      <Route path="boms/:id" element={<BomForm />} />
      <Route path="orders" element={<Orders />} />
      <Route path="orders/new" element={<OrderForm />} />
      <Route path="orders/:id" element={<OrderView />} />
      <Route path="orders/:id/edit" element={<OrderForm />} />
      <Route path="shop-floor" element={<ShopFloor />} />
      <Route path="calendar" element={<Calendar />} />
      <Route path="quality" element={<Quality />} />
      <Route path="mrp" element={<Mrp />} />
      <Route path="*" element={<Orders />} />
    </Routes>
  );
}

