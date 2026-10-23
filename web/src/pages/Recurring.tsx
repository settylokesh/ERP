import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { del, post, put } from '../api';
import { DataTable } from '../components/DataTable';
import { ContactPicker, ItemPicker, TaxSelect } from '../components/pickers';
import { Badge, Check, Field, Input, Modal, PageHeader, Select, useAction } from '../components/ui';
import { date, money, titleCase, today } from '../lib/format';
import { useApi, useCan } from '../lib/hooks';

export default function Recurring() {
  const { data, reload } = useApi<any[]>('/recurring');
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  const can = useCan();
  const total = (t: any) => (t?.lines ?? []).reduce((a: number, l: any) => a + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);
  return (
    <div>
      <PageHeader title="Recurring Invoices" subtitle="Invoice profiles generated automatically on schedule (checked hourly and on demand)"
        actions={can('sales', 'create') && <>
          <button className="btn" disabled={busy} onClick={async () => { const r = await run(() => post('/recurring/run', {})); if (r) { reload(); alert(`${r.created.length} invoice(s) generated`); } }}>Run due profiles now</button>
          <button className="btn btn-primary" onClick={() => setEdit({ frequency: 'monthly', every: 1, start_date: today(), status: 'active', template: { lines: [{ qty: 1 }] } })}><Plus className="h-4 w-4" />New Profile</button>
        </>} />
      <div className="p-5">
        <DataTable rows={data ?? []} onRow={(r) => setEdit(r)} cols={[
          { key: 'name', label: 'Profile', render: (r) => <span className="link">{r.name}</span> }, { key: 'contact_name', label: 'Customer' },
          { key: 'frequency', label: 'Frequency', render: (r) => `Every ${r.every > 1 ? `${r.every} ` : ''}${titleCase(r.frequency).replace(/ly$/, '')}${r.every > 1 ? 's' : ''}` },
          { key: 'next_date', label: 'Next invoice', render: (r) => date(r.next_date) }, { key: 'end_date', label: 'Ends', render: (r) => date(r.end_date) },
          { key: 'amount', label: 'Amount (pre-tax)', num: true, render: (r) => money(total(r.template)) }, { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
        ]} />
      </div>
      {edit && (
        <Modal wide title={edit.id ? `Edit ${edit.name}` : 'New recurring invoice'} onClose={() => setEdit(null)} footer={<>
          {edit.id && <button className="btn btn-danger mr-auto" onClick={async () => { if (await run(() => del(`/recurring/${edit.id}`), 'Deleted')) { setEdit(null); reload(); } }}>Delete</button>}
          <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (edit.id ? put(`/recurring/${edit.id}`, edit) : post('/recurring', edit)), 'Saved')) { setEdit(null); reload(); } }}>Save</button></>}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Profile name"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Customer" className="sm:col-span-2"><ContactPicker kind="customer" value={edit.contact_id} onChange={(v) => setEdit({ ...edit, contact_id: v })} /></Field>
            <Field label="Repeat"><Select value={edit.frequency} onChange={(e) => setEdit({ ...edit, frequency: e.target.value })} options={['weekly', 'monthly', 'quarterly', 'yearly'].map((f) => ({ value: f, label: titleCase(f) }))} /></Field>
            <Field label="Every"><Input type="number" min={1} value={edit.every} onChange={(e) => setEdit({ ...edit, every: Number(e.target.value) })} /></Field>
            <Field label="Status"><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })} options={[{ value: 'active', label: 'Active' }, { value: 'stopped', label: 'Stopped' }]} /></Field>
            <Field label="Starts on"><Input type="date" value={edit.start_date} onChange={(e) => setEdit({ ...edit, start_date: e.target.value, next_date: edit.id ? edit.next_date : e.target.value })} /></Field>
            <Field label="Next invoice date"><Input type="date" value={edit.next_date ?? edit.start_date} onChange={(e) => setEdit({ ...edit, next_date: e.target.value })} /></Field>
            <Field label="Ends on (optional)"><Input type="date" value={edit.end_date ?? ''} onChange={(e) => setEdit({ ...edit, end_date: e.target.value || null })} /></Field>
          </div>
          <table className="table mt-3"><thead><tr><th>Item</th><th className="num w-24">Qty</th><th className="num w-32">Rate</th><th className="w-28">Tax</th><th /></tr></thead>
            <tbody>{edit.template.lines.map((l: any, i: number) => {
              const u = (p: any) => setEdit({ ...edit, template: { ...edit.template, lines: edit.template.lines.map((x: any, j: number) => (j === i ? { ...x, ...p } : x)) } });
              return <tr key={i}><td><ItemPicker value={l.item_id} onChange={(v, it) => u({ item_id: v, rate: it?.sales_rate, tax_id: it?.tax_id })} /></td><td><Input type="number" className="text-right" value={l.qty} onChange={(e) => u({ qty: Number(e.target.value) })} /></td><td><Input type="number" className="text-right" value={l.rate ?? ''} onChange={(e) => u({ rate: Number(e.target.value) })} /></td><td><TaxSelect value={l.tax_id} onChange={(v) => u({ tax_id: v })} /></td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setEdit({ ...edit, template: { ...edit.template, lines: edit.template.lines.filter((_: any, j: number) => j !== i) } })} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button></td></tr>;
            })}</tbody></table>
          <button className="btn btn-sm mt-2" onClick={() => setEdit({ ...edit, template: { ...edit.template, lines: [...edit.template.lines, { qty: 1 }] } })}><Plus className="h-3.5 w-3.5" />Add line</button>
          <div className="mt-3"><Check label="Email the invoice to the customer automatically" checked={!!edit.auto_send} onChange={(v) => setEdit({ ...edit, auto_send: v })} /></div>
        </Modal>
      )}
    </div>
  );
}
