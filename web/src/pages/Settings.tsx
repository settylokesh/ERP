import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { del, download, get, post, put } from '../api';
import { DataTable } from '../components/DataTable';
import { StateSelect } from '../components/pickers';
import { Badge, Check, ErrorBox, Field, Input, KeyVal, Modal, PageHeader, Select, Spinner, Textarea, useAction } from '../components/ui';
import { dateTime, money, titleCase } from '../lib/format';
import { useApi, useMeta } from '../lib/hooks';

function Org() {
  const { reload } = useMeta();
  const { data } = useApi<any>('/settings/org');
  const [f, setF] = useState<any>(null);
  const { run, busy } = useAction();
  useEffect(() => { if (data) setF(data); }, [data]);
  if (!f) return <Spinner />;
  const set = (p: any) => setF({ ...f, ...p });
  return (
    <div className="space-y-4">
      <div className="card grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Organisation name"><Input value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Legal name"><Input value={f.legal_name} onChange={(e) => set({ legal_name: e.target.value })} /></Field>
        <Field label="Industry"><Input value={f.industry} onChange={(e) => set({ industry: e.target.value })} /></Field>
        <Field label="GSTIN"><Input value={f.gstin} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} /></Field>
        <Field label="State"><StateSelect value={f.state_code} onChange={(v) => set({ state_code: v })} /></Field>
        <Field label="PAN"><Input value={f.pan} onChange={(e) => set({ pan: e.target.value.toUpperCase() })} /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={f.address} onChange={(e) => set({ address: e.target.value })} /></Field>
        <Field label="City"><Input value={f.city} onChange={(e) => set({ city: e.target.value })} /></Field>
        <Field label="PIN code"><Input value={f.pincode} onChange={(e) => set({ pincode: e.target.value })} /></Field>
        <Field label="Email"><Input value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
      </div>
      <div className="card grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Fiscal year starts in"><Select value={f.fiscal_year_start_month} onChange={(e) => set({ fiscal_year_start_month: Number(e.target.value) })} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: new Date(2026, i, 1).toLocaleDateString('en-GB', { month: 'long' }) }))} /></Field>
        <Field label="Opening balance / inventory start date"><Input type="date" value={f.inventory_start_date} onChange={(e) => set({ inventory_start_date: e.target.value })} /></Field>
        <Field label="Inventory valuation" hint="Cannot change after stock transactions exist"><Select value={f.valuation_method} onChange={(e) => set({ valuation_method: e.target.value })} options={[{ value: 'fifo', label: 'FIFO' }, { value: 'wac', label: 'Weighted average' }]} /></Field>
        <Field label="e-Way bill threshold (₹)"><Input type="number" value={f.eway_threshold} onChange={(e) => set({ eway_threshold: Number(e.target.value) })} /></Field>
        <Field label="B2C Large threshold (₹)" hint="Inter-state B2C invoices above this go to GSTR-1 Table 5"><Input type="number" value={f.b2cl_threshold} onChange={(e) => set({ b2cl_threshold: Number(e.target.value) })} /></Field>
        <div className="space-y-2 pt-5">
          <Check label="Prevent stock from going negative" checked={!!f.prevent_negative_stock} onChange={(v) => set({ prevent_negative_stock: v })} />
          <Check label="My business must issue e-invoices (IRN)" checked={!!f.einvoice_enabled} onChange={(v) => set({ einvoice_enabled: v })} />
        </div>
        <Field label="Default invoice terms" className="sm:col-span-2 lg:col-span-3"><Textarea value={f.invoice_terms} onChange={(e) => set({ invoice_terms: e.target.value })} /></Field>
        <Field label="Default customer notes" className="sm:col-span-2 lg:col-span-3"><Textarea value={f.invoice_notes} onChange={(e) => set({ invoice_notes: e.target.value })} /></Field>
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => put('/settings/org', f), 'Organisation saved')) reload(); }}>Save</button>
    </div>
  );
}

const AdminNote = () => <p className="rounded-md bg-slate-50 p-2 text-xs text-slate-600">Only administrators can add users, change roles or reset passwords.</p>;

function Users() {
  const { meta } = useMeta();
  const admin = meta.user.is_admin;
  const { data, reload } = useApi<any[]>('/settings/users');
  const { data: roles } = useApi<any[]>('/settings/roles');
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  return (
    <div className="space-y-3">
      {admin ? <button className="btn btn-primary" onClick={() => setEdit({ is_active: true })}><Plus className="h-4 w-4" />Add user</button> : <AdminNote />}
      <DataTable rows={data ?? []} onRow={admin ? (r) => setEdit({ ...r, is_active: !!r.is_active }) : undefined} cols={[{ key: 'name', label: 'Name', render: (r) => <span className={admin ? 'link' : ''}>{r.name}</span> }, { key: 'email', label: 'Email' }, { key: 'role_name', label: 'Role' }, { key: 'last_login_at', label: 'Last sign-in', render: (r) => (r.last_login_at ? dateTime(r.last_login_at) : 'Never') }, { key: 'is_active', label: 'Status', render: (r) => <Badge status={r.is_active ? 'active' : 'inactive'} /> }]} />
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New user'} onClose={() => setEdit(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (edit.id ? put(`/settings/users/${edit.id}`, edit) : post('/settings/users', edit)), 'User saved')) { setEdit(null); reload(); } }}>Save</button>}>
          <div className="grid gap-3">
            <Field label="Name"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            {!edit.id && <Field label="Email"><Input value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>}
            <Field label="Role"><Select value={edit.role_id ?? ''} placeholder="Select role" onChange={(e) => setEdit({ ...edit, role_id: Number(e.target.value) })} options={(roles ?? []).map((r) => ({ value: r.id, label: r.name }))} /></Field>
            <Field label={edit.id ? 'Reset password (optional)' : 'Password'} hint="At least 8 characters"><Input type="password" value={edit.password ?? ''} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
            {edit.id && <Check label="Active" checked={edit.is_active} onChange={(v) => setEdit({ ...edit, is_active: v })} />}
          </div>
        </Modal>
      )}
    </div>
  );
}

const MODS = ['items', 'sales', 'purchases', 'inventory', 'manufacturing', 'accountant', 'banking', 'assets', 'payroll', 'compliance', 'reports', 'settings', 'custom'];
const ACTS = ['view', 'create', 'edit', 'delete', 'approve'];
function Roles() {
  const { meta } = useMeta();
  const admin = meta.user.is_admin;
  const { data, reload } = useApi<any[]>('/settings/roles');
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  return (
    <div className="space-y-3">
      {admin ? <button className="btn btn-primary" onClick={() => setEdit({ name: '', permissions: {} })}><Plus className="h-4 w-4" />New role</button> : <AdminNote />}
      <DataTable rows={data ?? []} onRow={admin ? (r) => !r.is_admin && setEdit(r) : undefined} cols={[{ key: 'name', label: 'Role', render: (r) => <span className={r.is_admin || !admin ? '' : 'link'}>{r.name}</span> }, { key: 'description', label: 'Description' }, { key: 'users', label: 'Users', num: true }]} />
      {edit && (
        <Modal wide title={edit.id ? `Edit role ${edit.name}` : 'New role'} onClose={() => setEdit(null)} footer={<>
          {edit.id && <button className="btn btn-danger mr-auto" onClick={async () => { if (await run(() => del(`/settings/roles/${edit.id}`), 'Role deleted')) { setEdit(null); reload(); } }}>Delete</button>}
          <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (edit.id ? put(`/settings/roles/${edit.id}`, edit) : post('/settings/roles', edit)), 'Role saved')) { setEdit(null); reload(); } }}>Save</button></>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Role name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Description"><Input value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          </div>
          <table className="table mt-3"><thead><tr><th>Module</th>{ACTS.map((a) => <th key={a} className="text-center">{titleCase(a)}</th>)}</tr></thead>
            <tbody>{MODS.map((m) => <tr key={m}><td className="capitalize">{m}</td>{ACTS.map((a) => <td key={a} className="text-center">
              <input type="checkbox" aria-label={`${m} ${a}`} checked={!!edit.permissions?.[m]?.[a]} onChange={(e) => setEdit({ ...edit, permissions: { ...edit.permissions, [m]: { ...edit.permissions?.[m], [a]: e.target.checked } } })} />
            </td>)}</tr>)}</tbody></table>
        </Modal>
      )}
    </div>
  );
}

function Taxes() {
  const { reload: reloadMeta } = useMeta();
  const { data: taxes, reload } = useApi<any[]>('/taxes');
  const { data: tds, reload: reloadTds } = useApi<any[]>('/tds-sections');
  const [t, setT] = useState<any>(null);
  const [s, setS] = useState<any>(null);
  const { run, busy } = useAction();
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-2"><div className="flex items-center justify-between"><h3>GST rates</h3><button className="btn btn-sm" onClick={() => setT({ rate: 0, is_active: true })}><Plus className="h-3.5 w-3.5" />Add</button></div>
        <DataTable rows={taxes ?? []} onRow={(r) => setT({ ...r, is_active: !!r.is_active })} cols={[{ key: 'name', label: 'Name', render: (r) => <span className="link">{r.name}</span> }, { key: 'rate', label: 'Rate %', num: true }, { key: 'is_active', label: 'Status', render: (r) => <Badge status={r.is_active ? 'active' : 'inactive'} /> }]} />
        <p className="text-xs text-slate-500">Intra-state supplies split the rate equally into CGST and SGST; inter-state supplies charge IGST. Rates reflect the GST rationalisation effective 22 Sep 2025 (0, 5, 18, 40% plus 3% and 0.25%); 12% and 28% are kept inactive for older documents.</p></div>
      <div className="space-y-2"><div className="flex items-center justify-between"><h3>TDS sections</h3><button className="btn btn-sm" onClick={() => setS({ rate: 0 })}><Plus className="h-3.5 w-3.5" />Add</button></div>
        <DataTable rows={tds ?? []} cols={[{ key: 'section', label: 'Section' }, { key: 'name', label: 'Nature of payment' }, { key: 'rate', label: 'Rate %', num: true }]} /></div>
      {t && <Modal title={t.id ? 'Edit GST rate' : 'New GST rate'} onClose={() => setT(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (t.id ? put(`/taxes/${t.id}`, t) : post('/taxes', t)), 'Saved')) { setT(null); reload(); reloadMeta(); } }}>Save</button>}>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Name"><Input value={t.name ?? ''} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field><Field label="Rate %"><Input type="number" value={t.rate} onChange={(e) => setT({ ...t, rate: Number(e.target.value) })} /></Field><Check label="Active" checked={t.is_active} onChange={(v) => setT({ ...t, is_active: v })} /></div></Modal>}
      {s && <Modal title="New TDS section" onClose={() => setS(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => post('/tds-sections', s), 'Saved')) { setS(null); reloadTds(); reloadMeta(); } }}>Save</button>}>
        <div className="grid gap-3 sm:grid-cols-3"><Field label="Section"><Input value={s.section ?? ''} onChange={(e) => setS({ ...s, section: e.target.value })} /></Field><Field label="Nature"><Input value={s.name ?? ''} onChange={(e) => setS({ ...s, name: e.target.value })} /></Field><Field label="Rate %"><Input type="number" value={s.rate} onChange={(e) => setS({ ...s, rate: Number(e.target.value) })} /></Field></div></Modal>}
    </div>
  );
}

function Warehouses() {
  const { reload: reloadMeta } = useMeta();
  const { data, reload } = useApi<any[]>('/warehouses');
  const { data: cur, reload: reloadCur } = useApi<any[]>('/currencies');
  const [w, setW] = useState<any>(null);
  const [c, setC] = useState<any>(null);
  const { run, busy } = useAction();
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-2"><div className="flex items-center justify-between"><h3>Warehouses / locations</h3><button className="btn btn-sm" onClick={() => setW({ is_active: true })}><Plus className="h-3.5 w-3.5" />Add</button></div>
        <DataTable rows={data ?? []} onRow={(r) => setW({ ...r, is_active: !!r.is_active, is_primary: !!r.is_primary })} cols={[{ key: 'name', label: 'Name', render: (r) => <span className="link">{r.name}{r.is_primary ? ' (primary)' : ''}</span> }, { key: 'code', label: 'Code' }, { key: 'gstin', label: 'GSTIN' }, { key: 'is_active', label: 'Status', render: (r) => <Badge status={r.is_active ? 'active' : 'inactive'} /> }]} /></div>
      <div className="space-y-2"><div className="flex items-center justify-between"><h3>Currencies</h3><button className="btn btn-sm" onClick={() => setC({ rate: 1 })}><Plus className="h-3.5 w-3.5" />Add</button></div>
        <DataTable rows={cur ?? []} onRow={(r) => !r.is_base && setC(r)} cols={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'rate', label: '₹ per unit', num: true, render: (r) => (r.is_base ? 'Base currency' : money(r.rate)) }]} />
        <p className="text-xs text-slate-500">Exchange rates are entered manually; update them before recording foreign currency transactions.</p></div>
      {w && <Modal title={w.id ? 'Edit warehouse' : 'New warehouse'} onClose={() => setW(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (w.id ? put(`/warehouses/${w.id}`, w) : post('/warehouses', w)), 'Saved')) { setW(null); reload(); reloadMeta(); } }}>Save</button>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={w.name ?? ''} onChange={(e) => setW({ ...w, name: e.target.value })} /></Field><Field label="Code"><Input value={w.code ?? ''} onChange={(e) => setW({ ...w, code: e.target.value })} /></Field>
          <Field label="State"><StateSelect value={w.state_code} onChange={(v) => setW({ ...w, state_code: v })} /></Field><Field label="GSTIN (if separately registered)"><Input value={w.gstin ?? ''} onChange={(e) => setW({ ...w, gstin: e.target.value.toUpperCase() })} /></Field>
          <Field label="Address" className="sm:col-span-2"><Textarea value={w.address ?? ''} onChange={(e) => setW({ ...w, address: e.target.value })} /></Field>
          <Field label="City"><Input value={w.city ?? ''} onChange={(e) => setW({ ...w, city: e.target.value })} /></Field><Field label="PIN code" hint="Used as the dispatch address on e-way bills"><Input value={w.pincode ?? ''} onChange={(e) => setW({ ...w, pincode: e.target.value })} /></Field>
          <Check label="Primary" checked={!!w.is_primary} onChange={(v) => setW({ ...w, is_primary: v })} /><Check label="Active" checked={w.is_active} onChange={(v) => setW({ ...w, is_active: v })} />
        </div></Modal>}
      {c && <Modal title="Currency" onClose={() => setC(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => post('/currencies', c), 'Saved')) { setC(null); reloadCur(); reloadMeta(); } }}>Save</button>}>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Code"><Input value={c.code ?? ''} onChange={(e) => setC({ ...c, code: e.target.value.toUpperCase() })} /></Field><Field label="Name"><Input value={c.name ?? ''} onChange={(e) => setC({ ...c, name: e.target.value })} /></Field><Field label="Symbol"><Input value={c.symbol ?? ''} onChange={(e) => setC({ ...c, symbol: e.target.value })} /></Field><Field label="Rate (₹ per 1 unit)"><Input type="number" value={c.rate} onChange={(e) => setC({ ...c, rate: Number(e.target.value) })} /></Field></div></Modal>}
    </div>
  );
}

function Approvals() {
  const { meta, reload } = useMeta();
  const { data: roles } = useApi<any[]>('/settings/roles');
  const [cfg, setCfg] = useState<Record<string, any>>(meta.approvals);
  const { run, busy } = useAction();
  const types = Object.values(meta.doc_types).filter((t: any) => t.approvable) as any[];
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">Documents that need approval stay in “Pending Approval” and do not affect stock or accounts until approved. Simple approval lets anyone with Approve permission approve; multi-level approval requires each listed role in order.</p>
      <div className="card divide-y divide-slate-100">
        {types.map((t) => {
          const c = cfg[t.type] ?? { mode: 'none', levels: [] };
          return (
            <div key={t.type} className="flex flex-wrap items-center gap-3 p-3">
              <div className="w-48 font-medium">{t.plural}</div>
              <Select aria-label={`${t.label} approval`} className="w-48" value={c.mode} onChange={(e) => setCfg({ ...cfg, [t.type]: { ...c, mode: e.target.value } })} options={[{ value: 'none', label: 'No approval' }, { value: 'simple', label: 'Simple approval' }, { value: 'multi', label: 'Multi-level approval' }]} />
              {c.mode === 'multi' && (
                <div className="flex flex-wrap items-center gap-2">
                  {c.levels.map((l: number, i: number) => <span key={i} className="chip bg-slate-100">L{i + 1}: {roles?.find((r) => r.id === l)?.name}<button className="ml-1" onClick={() => setCfg({ ...cfg, [t.type]: { ...c, levels: c.levels.filter((_: any, j: number) => j !== i) } })} aria-label="Remove level">×</button></span>)}
                  <select className="input w-44" value="" onChange={(e) => e.target.value && setCfg({ ...cfg, [t.type]: { ...c, levels: [...c.levels, Number(e.target.value)] } })} aria-label="Add approver level"><option value="">+ Add level</option>{(roles ?? []).filter((r) => !r.is_admin).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => put('/settings/approvals', cfg), 'Approval settings saved')) reload(); }}>Save</button>
    </div>
  );
}

function Workflows() {
  const { meta } = useMeta();
  const { data, reload } = useApi<any[]>('/settings/workflows');
  const { data: log } = useApi<any[]>('/settings/workflow-log');
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  const modules = [...Object.values(meta.doc_types).map((t: any) => ({ value: t.type, label: t.plural })), { value: 'payment_received', label: 'Payments Received' }, { value: 'payment_made', label: 'Payments Made' }, ...meta.custom_modules.map((m) => ({ value: `custom:${m.key}`, label: m.plural }))];
  return (
    <div className="space-y-3">
      <button className="btn btn-primary" onClick={() => setEdit({ trigger: 'on_create', conditions: [], actions: [{ type: 'notify', to: 'admins' }], is_active: true })}><Plus className="h-4 w-4" />New workflow rule</button>
      <DataTable rows={data ?? []} onRow={(r) => setEdit({ ...r, is_active: !!r.is_active })} cols={[{ key: 'name', label: 'Rule', render: (r) => <span className="link">{r.name}</span> }, { key: 'module', label: 'Module' }, { key: 'trigger', label: 'When', render: (r) => titleCase(r.trigger) }, { key: 'a', label: 'Actions', render: (r) => r.actions.map((a: any) => titleCase(a.type)).join(', ') }, { key: 'is_active', label: 'Status', render: (r) => <Badge status={r.is_active ? 'active' : 'inactive'} /> }]} />
      {log && log.length > 0 && <div className="card p-4"><h3 className="mb-2">Recent executions</h3>{log.slice(0, 15).map((l) => <div key={l.id} className="text-xs"><span className="text-slate-500">{dateTime(l.at)}</span> · {l.name} · {l.entity} #{l.entity_id} · {l.result}</div>)}</div>}
      {edit && (
        <Modal wide title={edit.id ? 'Edit workflow rule' : 'New workflow rule'} onClose={() => setEdit(null)} footer={<>
          {edit.id && <button className="btn btn-danger mr-auto" onClick={async () => { if (await run(() => del(`/settings/workflows/${edit.id}`), 'Deleted')) { setEdit(null); reload(); } }}>Delete</button>}
          <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (edit.id ? put(`/settings/workflows/${edit.id}`, edit) : post('/settings/workflows', edit)), 'Rule saved')) { setEdit(null); reload(); } }}>Save</button></>}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Rule name"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Module"><Select value={edit.module ?? ''} placeholder="Select" onChange={(e) => setEdit({ ...edit, module: e.target.value })} options={modules} /></Field>
            <Field label="When"><Select value={edit.trigger} onChange={(e) => setEdit({ ...edit, trigger: e.target.value })} options={[{ value: 'on_create', label: 'Created' }, { value: 'on_update', label: 'Edited' }, { value: 'on_create_or_update', label: 'Created or edited' }, { value: 'on_status_change', label: 'Status changes' }]} /></Field>
          </div>
          <h3 className="mb-1 mt-4">Conditions (all must match)</h3>
          {edit.conditions.map((c: any, i: number) => {
            const upd = (p: any) => setEdit({ ...edit, conditions: edit.conditions.map((x: any, j: number) => (j === i ? { ...x, ...p } : x)) });
            return <div key={i} className="mb-2 flex gap-2"><Input placeholder="field (e.g. total, status, custom.region)" value={c.field ?? ''} onChange={(e) => upd({ field: e.target.value })} /><Select value={c.op ?? 'eq'} onChange={(e) => upd({ op: e.target.value })} options={['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'empty', 'not_empty'].map((o) => ({ value: o, label: o }))} /><Input placeholder="value" value={c.value ?? ''} onChange={(e) => upd({ value: e.target.value })} /><button className="btn btn-ghost" onClick={() => setEdit({ ...edit, conditions: edit.conditions.filter((_: any, j: number) => j !== i) })} aria-label="Remove"><Trash2 className="h-4 w-4" /></button></div>;
          })}
          <button className="btn btn-sm" onClick={() => setEdit({ ...edit, conditions: [...edit.conditions, { op: 'eq' }] })}><Plus className="h-3.5 w-3.5" />Add condition</button>
          <h3 className="mb-1 mt-4">Actions</h3>
          {edit.actions.map((a: any, i: number) => {
            const upd = (p: any) => setEdit({ ...edit, actions: edit.actions.map((x: any, j: number) => (j === i ? { ...x, ...p } : x)) });
            return (
              <div key={i} className="mb-2 grid gap-2 rounded border border-slate-200 p-2 sm:grid-cols-4">
                <Select aria-label="Action type" value={a.type} onChange={(e) => upd({ type: e.target.value })} options={[{ value: 'notify', label: 'In-app notification' }, { value: 'email', label: 'Email alert' }, { value: 'field_update', label: 'Field update' }, { value: 'webhook', label: 'Webhook' }]} />
                {a.type === 'notify' && <><Input placeholder="to: admins | creator | role:ID | user:ID" value={a.to ?? ''} onChange={(e) => upd({ to: e.target.value })} /><Input placeholder="Title, e.g. Invoice ${number}" value={a.title ?? ''} onChange={(e) => upd({ title: e.target.value })} /><Input placeholder="Body" value={a.body ?? ''} onChange={(e) => upd({ body: e.target.value })} /></>}
                {a.type === 'email' && <><Input placeholder="to: contact or an address" value={a.to ?? ''} onChange={(e) => upd({ to: e.target.value })} /><Input placeholder="Subject" value={a.subject ?? ''} onChange={(e) => upd({ subject: e.target.value })} /><Input placeholder="Body" value={a.body ?? ''} onChange={(e) => upd({ body: e.target.value })} /></>}
                {a.type === 'field_update' && <><Input placeholder="field: reference | salesperson | notes | custom.x" value={a.field ?? ''} onChange={(e) => upd({ field: e.target.value })} /><Input placeholder="value" value={a.value ?? ''} onChange={(e) => upd({ value: e.target.value })} /></>}
                {a.type === 'webhook' && <Input className="sm:col-span-2" placeholder="https://…" value={a.url ?? ''} onChange={(e) => upd({ url: e.target.value })} />}
              </div>
            );
          })}
          <button className="btn btn-sm" onClick={() => setEdit({ ...edit, actions: [...edit.actions, { type: 'notify', to: 'admins' }] })}><Plus className="h-3.5 w-3.5" />Add action</button>
          <div className="mt-3"><Check label="Active" checked={edit.is_active} onChange={(v) => setEdit({ ...edit, is_active: v })} /></div>
        </Modal>
      )}
    </div>
  );
}

const FIELD_TYPES = ['text', 'textarea', 'number', 'decimal', 'currency', 'date', 'checkbox', 'dropdown', 'email', 'phone', 'url', 'lookup_customer', 'lookup_vendor', 'lookup_item'];
function CustomFields() {
  const { meta, reload: reloadMeta } = useMeta();
  const { data, reload } = useApi<any[]>('/settings/custom-fields');
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  const modules = [{ value: 'customer', label: 'Customers' }, { value: 'vendor', label: 'Vendors' }, { value: 'item', label: 'Items' }, ...Object.values(meta.doc_types).map((t: any) => ({ value: t.type, label: t.plural }))];
  return (
    <div className="space-y-3">
      <button className="btn btn-primary" onClick={() => setEdit({ type: 'text', options: [] })}><Plus className="h-4 w-4" />New custom field</button>
      <DataTable rows={data ?? []} onRow={(r) => setEdit(r)} cols={[{ key: 'module', label: 'Module', render: (r) => modules.find((m) => m.value === r.module)?.label ?? r.module }, { key: 'label', label: 'Label', render: (r) => <span className="link">{r.label}</span> }, { key: 'key', label: 'Key' }, { key: 'type', label: 'Type' }, { key: 'required', label: 'Required', render: (r) => (r.required ? 'Yes' : '') }]} />
      {edit && (
        <Modal title="Custom field" onClose={() => setEdit(null)} footer={<>
          {edit.id && <button className="btn btn-danger mr-auto" onClick={async () => { if (await run(() => del(`/settings/custom-fields/${edit.id}`), 'Deleted')) { setEdit(null); reload(); reloadMeta(); } }}>Delete</button>}
          <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (edit.id ? put(`/settings/custom-fields/${edit.id}`, edit) : post('/settings/custom-fields', edit)), 'Saved')) { setEdit(null); reload(); reloadMeta(); } }}>Save</button></>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Module"><Select value={edit.module ?? ''} placeholder="Select" onChange={(e) => setEdit({ ...edit, module: e.target.value })} options={modules} /></Field>
            <Field label="Label"><Input value={edit.label ?? ''} onChange={(e) => setEdit({ ...edit, label: e.target.value, key: edit.id ? edit.key : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') })} /></Field>
            <Field label="Key"><Input value={edit.key ?? ''} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, key: e.target.value })} /></Field>
            <Field label="Type"><Select value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })} options={FIELD_TYPES.filter((t) => !t.startsWith('lookup')).map((t) => ({ value: t, label: titleCase(t) }))} /></Field>
            {edit.type === 'dropdown' && <Field label="Options (comma separated)" className="sm:col-span-2"><Input value={(edit.options ?? []).join(', ')} onChange={(e) => setEdit({ ...edit, options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>}
            <Check label="Required" checked={!!edit.required} onChange={(v) => setEdit({ ...edit, required: v })} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function CustomModules() {
  const { reload: reloadMeta } = useMeta();
  const { data, reload } = useApi<any[]>('/custom-modules');
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">Build your own modules (e.g. machine logs, service tickets, visitor register) with typed fields. They appear in the sidebar and support workflow rules.</p>
      <button className="btn btn-primary" onClick={() => setEdit({ key: '', name: '', plural: '', prefix: 'REC-', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }] })}><Plus className="h-4 w-4" />New module</button>
      <DataTable rows={data ?? []} onRow={(r) => setEdit(r)} cols={[{ key: 'name', label: 'Module', render: (r) => <span className="link">{r.plural}</span> }, { key: 'key', label: 'Key' }, { key: 'fields', label: 'Fields', render: (r) => r.fields.length }, { key: 'open', label: '', render: (r) => <Link to={`/custom/${r.key}`} onClick={(e) => e.stopPropagation()}>Open</Link> }]} />
      {edit && (
        <Modal wide title={edit.id ? `Edit ${edit.name}` : 'New custom module'} onClose={() => setEdit(null)} footer={<>
          {edit.id && <button className="btn btn-danger mr-auto" onClick={async () => { if (await run(() => del(`/custom-modules/${edit.id}`), 'Module deleted')) { setEdit(null); reload(); reloadMeta(); } }}>Delete</button>}
          <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (edit.id ? put(`/custom-modules/${edit.id}`, edit) : post('/custom-modules', edit)), 'Module saved')) { setEdit(null); reload(); reloadMeta(); } }}>Save</button></>}>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Singular name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Plural name"><Input value={edit.plural} onChange={(e) => setEdit({ ...edit, plural: e.target.value })} /></Field>
            <Field label="Key"><Input value={edit.key} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></Field>
            <Field label="Number prefix"><Input value={edit.prefix} onChange={(e) => setEdit({ ...edit, prefix: e.target.value })} /></Field>
          </div>
          <table className="table mt-3"><thead><tr><th>Label</th><th>Key</th><th>Type</th><th>Options</th><th>Required</th><th /></tr></thead>
            <tbody>{edit.fields.map((f: any, i: number) => {
              const upd = (p: any) => setEdit({ ...edit, fields: edit.fields.map((x: any, j: number) => (j === i ? { ...x, ...p } : x)) });
              return <tr key={i}><td><Input value={f.label} onChange={(e) => upd({ label: e.target.value, key: f.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_') })} /></td><td><Input value={f.key} onChange={(e) => upd({ key: e.target.value })} /></td>
                <td><Select aria-label="Field type" value={f.type} onChange={(e) => upd({ type: e.target.value })} options={FIELD_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} /></td>
                <td>{f.type === 'dropdown' && <Input value={(f.options ?? []).join(', ')} onChange={(e) => upd({ options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />}</td>
                <td><input type="checkbox" checked={!!f.required} onChange={(e) => upd({ required: e.target.checked })} aria-label="Required" /></td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setEdit({ ...edit, fields: edit.fields.filter((_: any, j: number) => j !== i) })} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button></td></tr>;
            })}</tbody></table>
          <button className="btn btn-sm mt-2" onClick={() => setEdit({ ...edit, fields: [...edit.fields, { key: '', label: '', type: 'text' }] })}><Plus className="h-3.5 w-3.5" />Add field</button>
        </Modal>
      )}
    </div>
  );
}

function Sequences() {
  const { data, reload } = useApi<any[]>('/settings/sequences');
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  return (
    <div className="space-y-3">
      <DataTable rows={data ?? []} onRow={(r) => setEdit(r)} cols={[{ key: 'type', label: 'Transaction', render: (r) => <span className="link">{titleCase(r.type)}</span> }, { key: 'prefix', label: 'Prefix' }, { key: 'next_no', label: 'Next number', num: true }, { key: 'preview', label: 'Next document', render: (r) => `${r.prefix}${String(r.next_no).padStart(r.padding, '0')}` }]} />
      {edit && <Modal title={`Numbering — ${titleCase(edit.type)}`} onClose={() => setEdit(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => put(`/settings/sequences/${edit.type}`, edit), 'Saved')) { setEdit(null); reload(); } }}>Save</button>}>
        <div className="grid gap-3 sm:grid-cols-3"><Field label="Prefix"><Input value={edit.prefix} onChange={(e) => setEdit({ ...edit, prefix: e.target.value })} /></Field><Field label="Next number"><Input type="number" value={edit.next_no} onChange={(e) => setEdit({ ...edit, next_no: Number(e.target.value) })} /></Field><Field label="Digits"><Input type="number" value={edit.padding} onChange={(e) => setEdit({ ...edit, padding: Number(e.target.value) })} /></Field></div></Modal>}
    </div>
  );
}

function PayrollSettings() {
  const [f, setF] = useState<any>(null);
  const { data: slabs, reload } = useApi<any[]>('/payroll/pt-slabs');
  const { data: comps, reload: reloadComps } = useApi<any[]>('/payroll/components');
  const [slabState, setSlabState] = useState('29');
  const [slabEdit, setSlabEdit] = useState<any[] | null>(null);
  const [comp, setComp] = useState<any>(null);
  const { run, busy } = useAction();
  useEffect(() => { get('/settings/payroll').then(setF); }, []);
  if (!f) return <Spinner />;
  const pf = (p: any) => setF({ ...f, pf: { ...f.pf, ...p } });
  const esi = (p: any) => setF({ ...f, esi: { ...f.esi, ...p } });
  const tds = (p: any) => setF({ ...f, tds: { ...f.tds, ...p } });
  return (
    <div className="space-y-4">
      <div className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">Statutory rates change by government notification. Defaults: EPF 12%/12% with EPS 8.33% on wages up to ₹15,000; EPF wage ceiling ₹15,000, raised to ₹25,000 from 17-Sep-2026 (S.O. 5109(E) as reported by BDO and KPMG — verify against the gazette); ESI 0.75%/3.25% for gross up to ₹21,000; new-regime tax slabs for FY 2026-27 with the ₹12 lakh rebate and ₹75,000 standard deduction. Review before running payroll.</div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card space-y-3 p-4"><h3>EPF</h3>
          <Check label="Enabled" checked={f.pf.enabled} onChange={(v) => pf({ enabled: v })} />
          <div className="grid grid-cols-2 gap-2"><Field label="Employee %"><Input type="number" value={f.pf.employee_rate} onChange={(e) => pf({ employee_rate: Number(e.target.value) })} /></Field><Field label="Employer %"><Input type="number" value={f.pf.employer_rate} onChange={(e) => pf({ employer_rate: Number(e.target.value) })} /></Field>
            <Field label="EPS %"><Input type="number" value={f.pf.eps_rate} onChange={(e) => pf({ eps_rate: Number(e.target.value) })} /></Field><Field label="EPS wage cap ₹"><Input type="number" value={f.pf.eps_wage_cap} onChange={(e) => pf({ eps_wage_cap: Number(e.target.value) })} /></Field>
            <Field label="EDLI %"><Input type="number" value={f.pf.edli_rate} onChange={(e) => pf({ edli_rate: Number(e.target.value) })} /></Field><Field label="Admin %"><Input type="number" value={f.pf.admin_rate} onChange={(e) => pf({ admin_rate: Number(e.target.value) })} /></Field></div>
          <Check label="Restrict PF wage to the ceiling" checked={f.pf.restrict_to_ceiling} onChange={(v) => pf({ restrict_to_ceiling: v })} />
          <div className="text-xs font-medium">Wage ceilings (effective from)</div>
          {f.pf.wage_ceilings.map((c: any, i: number) => <div key={i} className="flex gap-2"><Input type="date" value={c.from} onChange={(e) => pf({ wage_ceilings: f.pf.wage_ceilings.map((x: any, j: number) => (j === i ? { ...x, from: e.target.value } : x)) })} /><Input type="number" value={c.amount} onChange={(e) => pf({ wage_ceilings: f.pf.wage_ceilings.map((x: any, j: number) => (j === i ? { ...x, amount: Number(e.target.value) } : x)) })} /></div>)}
          <button className="btn btn-sm" onClick={() => pf({ wage_ceilings: [...f.pf.wage_ceilings, { from: new Date().toISOString().slice(0, 10), amount: 15000 }] })}>Add ceiling</button>
        </div>
        <div className="card space-y-3 p-4"><h3>ESI</h3>
          <Check label="Enabled" checked={f.esi.enabled} onChange={(v) => esi({ enabled: v })} />
          <div className="grid grid-cols-2 gap-2"><Field label="Employee %"><Input type="number" value={f.esi.employee_rate} onChange={(e) => esi({ employee_rate: Number(e.target.value) })} /></Field><Field label="Employer %"><Input type="number" value={f.esi.employer_rate} onChange={(e) => esi({ employer_rate: Number(e.target.value) })} /></Field>
            <Field label="Wage limit ₹" className="col-span-2"><Input type="number" value={f.esi.wage_limit} onChange={(e) => esi({ wage_limit: Number(e.target.value) })} /></Field></div>
          <h3 className="pt-2">Salary template</h3>
          <div className="grid grid-cols-2 gap-2"><Field label="Basic % of CTC"><Input type="number" value={comps?.find((c) => c.code === 'BASIC')?.value ?? ''} disabled /></Field><Field label="HRA % of basic"><Input type="number" value={comps?.find((c) => c.code === 'HRA')?.value ?? ''} disabled /></Field></div>
          <DataTable rows={comps ?? []} onRow={(r) => setComp(r)} cols={[{ key: 'name', label: 'Component', render: (r) => <span className="link">{r.name}</span> }, { key: 'calc', label: 'Calculation', render: (r) => (r.calc === 'pct_ctc' ? `${r.value}% of CTC` : r.calc === 'pct_basic' ? `${r.value}% of basic` : r.calc === 'balance' ? 'Balancing figure' : `₹${r.value}/month`) }]} />
          <button className="btn btn-sm" onClick={() => setComp({ calc: 'fixed', value: 0, esi_applicable: true })}><Plus className="h-3.5 w-3.5" />Add component</button>
        </div>
        <div className="card space-y-3 p-4"><h3>Income tax (TDS on salary)</h3>
          <Check label="Enabled" checked={f.tds.enabled} onChange={(v) => tds({ enabled: v })} />
          <div className="grid grid-cols-2 gap-2"><Field label="Standard deduction ₹"><Input type="number" value={f.tds.standard_deduction} onChange={(e) => tds({ standard_deduction: Number(e.target.value) })} /></Field><Field label="Cess %"><Input type="number" value={f.tds.cess_rate} onChange={(e) => tds({ cess_rate: Number(e.target.value) })} /></Field>
            <Field label="Rebate income limit ₹"><Input type="number" value={f.tds.rebate_income_limit} onChange={(e) => tds({ rebate_income_limit: Number(e.target.value) })} /></Field><Field label="Max rebate ₹"><Input type="number" value={f.tds.rebate_max} onChange={(e) => tds({ rebate_max: Number(e.target.value) })} /></Field></div>
          <table className="table"><thead><tr><th>Up to ₹</th><th className="num">Rate %</th></tr></thead><tbody>{f.tds.slabs.map((s: any, i: number) => <tr key={i}><td>{s.upto == null ? 'Above' : <Input type="number" value={s.upto} onChange={(e) => tds({ slabs: f.tds.slabs.map((x: any, j: number) => (j === i ? { ...x, upto: Number(e.target.value) } : x)) })} />}</td><td><Input type="number" className="text-right" value={s.rate} onChange={(e) => tds({ slabs: f.tds.slabs.map((x: any, j: number) => (j === i ? { ...x, rate: Number(e.target.value) } : x)) })} /></td></tr>)}</tbody></table>
        </div>
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => put('/settings/payroll', f), 'Payroll settings saved'); if (r) setF(r); }}>Save payroll settings</button>
      <div className="card space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2"><h3>Professional tax slabs</h3><div className="w-64"><StateSelect value={slabState} onChange={(v) => { setSlabState(v); setSlabEdit(null); }} /></div>
          <button className="btn btn-sm" onClick={() => setSlabEdit((slabs ?? []).filter((s) => s.state_code === slabState))}>Edit slabs</button></div>
        <p className="text-xs text-slate-500">Karnataka is pre-configured (₹200/month for salaries of ₹25,000+, ₹300 in February). Add slabs for other states from the state's PT schedule.</p>
        {slabEdit ? (
          <>
            <table className="table"><thead><tr><th>Monthly gross from ₹</th><th>to ₹ (blank = no limit)</th><th>PT ₹</th><th>February PT ₹</th><th /></tr></thead>
              <tbody>{slabEdit.map((s, i) => { const u = (p: any) => setSlabEdit(slabEdit.map((x, j) => (j === i ? { ...x, ...p } : x))); return <tr key={i}><td><Input type="number" value={s.min_salary} onChange={(e) => u({ min_salary: e.target.value })} /></td><td><Input type="number" value={s.max_salary ?? ''} onChange={(e) => u({ max_salary: e.target.value })} /></td><td><Input type="number" value={s.amount} onChange={(e) => u({ amount: e.target.value })} /></td><td><Input type="number" value={s.feb_amount ?? ''} onChange={(e) => u({ feb_amount: e.target.value })} /></td><td><button className="btn btn-ghost btn-sm" onClick={() => setSlabEdit(slabEdit.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button></td></tr>; })}</tbody></table>
            <div className="flex gap-2"><button className="btn btn-sm" onClick={() => setSlabEdit([...slabEdit, { min_salary: 0, max_salary: '', amount: 0, feb_amount: '' }])}>Add slab</button><button className="btn btn-sm btn-primary" disabled={busy} onClick={async () => { if (await run(() => put('/payroll/pt-slabs', { state_code: slabState, slabs: slabEdit }), 'PT slabs saved')) { setSlabEdit(null); reload(); } }}>Save slabs</button></div>
          </>
        ) : (
          <DataTable rows={(slabs ?? []).filter((s) => s.state_code === slabState)} cols={[{ key: 'min_salary', label: 'From', num: true, render: (r) => money(r.min_salary) }, { key: 'max_salary', label: 'To', num: true, render: (r) => (r.max_salary == null ? 'No limit' : money(r.max_salary)) }, { key: 'amount', label: 'PT / month', num: true, render: (r) => money(r.amount) }, { key: 'feb_amount', label: 'February', num: true, render: (r) => (r.feb_amount == null ? '-' : money(r.feb_amount)) }]} empty={<div className="p-4 text-slate-500">No professional tax configured for this state.</div>} />
        )}
      </div>
      {comp && (
        <Modal title={comp.id ? `Edit ${comp.name}` : 'New salary component'} onClose={() => setComp(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (comp.id ? put(`/payroll/components/${comp.id}`, comp) : post('/payroll/components', comp)), 'Saved')) { setComp(null); reloadComps(); } }}>Save</button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            {!comp.id && <Field label="Code"><Input value={comp.code ?? ''} onChange={(e) => setComp({ ...comp, code: e.target.value.toUpperCase() })} /></Field>}
            <Field label="Name"><Input value={comp.name ?? ''} onChange={(e) => setComp({ ...comp, name: e.target.value })} /></Field>
            {!comp.id && <Field label="Calculation"><Select value={comp.calc} onChange={(e) => setComp({ ...comp, calc: e.target.value })} options={[{ value: 'fixed', label: 'Fixed amount per month' }, { value: 'pct_ctc', label: '% of CTC' }, { value: 'pct_basic', label: '% of basic' }]} /></Field>}
            {comp.calc !== 'balance' && <Field label="Value"><Input type="number" value={comp.value} onChange={(e) => setComp({ ...comp, value: Number(e.target.value) })} /></Field>}
            <Check label="Counts towards PF wage" checked={!!comp.pf_applicable} onChange={(v) => setComp({ ...comp, pf_applicable: v })} />
            <Check label="Active" checked={comp.is_active !== 0 && comp.is_active !== false} onChange={(v) => setComp({ ...comp, is_active: v })} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function Logs() {
  const { data, reload } = useApi<{ configured: boolean; rows: any[] }>('/settings/email-log');
  const { run, busy } = useAction();
  const unsent = (data?.rows ?? []).filter((r) => r.status !== 'sent').length;
  return (
    <div className="space-y-3">
      {data && !data.configured && <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-800">Email delivery is not configured, so emails stay queued here. Set <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASSWORD</code> and <code>SMTP_FROM</code> on the server to send them.</p>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500">Every email the system sends is listed here. The full activity trail is in <Link to="/reports/audit_trail">Reports → Audit Trail</Link>.</p>
        {data?.configured && unsent > 0 && <button className="btn btn-sm" disabled={busy} onClick={async () => { if (await run(() => post('/settings/email-log/retry', {}), 'Sending again')) setTimeout(reload, 1500); }}>Retry unsent ({unsent})</button>}
      </div>
      <DataTable rows={data?.rows ?? []} cols={[{ key: 'at', label: 'Time', render: (r) => dateTime(r.at) }, { key: 'to_addr', label: 'To' }, { key: 'subject', label: 'Subject' }, { key: 'entity', label: 'Module' },
        { key: 'status', label: 'Status', render: (r) => <span title={r.error ?? ''}><Badge status={r.status === 'sent' ? 'paid' : r.status === 'failed' ? 'overdue' : 'pending'} label={titleCase(r.status)} /></span> }]} />
    </div>
  );
}

function System() {
  const { meta } = useMeta();
  const { data, error } = useApi<any>(meta.user.is_admin ? '/admin/system' : null);
  const { run, busy } = useAction();
  if (!meta.user.is_admin) return <AdminNote />;
  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      <div className="card p-5">
        <h3 className="mb-2">Backup</h3>
        <p className="mb-3 text-xs text-slate-600">Downloads a consistent copy of the whole database (all transactions, users and settings): a SQLite file, or on Cloudflare a SQL file that the sqlite3 tool can load. Keep backups somewhere safe and off this server: they contain everything in the system.</p>
        <button className="btn btn-primary" disabled={busy} onClick={() => run(() => download('/admin/backup', 'saral-backup.db'), 'Backup downloaded')}>Download backup</button>
      </div>
      {data && <div className="card p-5"><h3 className="mb-2">System</h3><KeyVal items={[['Database schema version', `${data.schema_version} (latest ${data.latest_schema_version})`], ['Runtime', data.runtime], ['Users', data.users], ['Transactions', data.documents], ['Journal entries', data.journals]]} /></div>}
    </div>
  );
}

const SECTIONS: [string, string, () => JSX.Element][] = [
  ['', 'Organisation', Org], ['users', 'Users', Users], ['roles', 'Roles & Permissions', Roles], ['taxes', 'Taxes & TDS', Taxes],
  ['locations', 'Warehouses & Currencies', Warehouses], ['approvals', 'Approvals', Approvals], ['workflows', 'Workflow Rules', Workflows],
  ['custom-fields', 'Custom Fields', CustomFields], ['custom-modules', 'Custom Modules', CustomModules], ['numbering', 'Transaction Numbering', Sequences],
  ['payroll', 'Payroll & Statutory', PayrollSettings], ['logs', 'Email Log', Logs], ['system', 'System & Backup', System],
];

export default function Settings() {
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-5 p-5 lg:flex-row">
        <nav className="card h-fit w-full shrink-0 p-2 lg:w-56" aria-label="Settings sections">
          {SECTIONS.map(([path, label]) => <NavLink key={path} end to={`/settings${path ? `/${path}` : ''}`} className={({ isActive }) => `block rounded px-3 py-1.5 text-[13px] no-underline ${isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}>{label}</NavLink>)}
        </nav>
        <div className="min-w-0 flex-1">
          <Routes>{SECTIONS.map(([path, , C]) => (path ? <Route key={path} path={path} element={<C />} /> : <Route key="index" index element={<C />} />))}</Routes>
        </div>
      </div>
    </div>
  );
}

