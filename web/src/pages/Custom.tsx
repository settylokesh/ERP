import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { del, post, put } from '../api';
import { DataTable } from '../components/DataTable';
import { Combo, useContacts, useItems } from '../components/pickers';
import { Check, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, useAction } from '../components/ui';
import { date, dateTime, money } from '../lib/format';
import { useApi, useCan, useDebounced } from '../lib/hooks';

function FieldInput({ f, value, onChange }: { f: any; value: any; onChange: (v: any) => void }) {
  const { contacts: customers } = useContacts(f.type === 'lookup_customer' ? 'customer' : null);
  const { contacts: vendors } = useContacts(f.type === 'lookup_vendor' ? 'vendor' : null);
  const { items } = useItems();
  switch (f.type) {
    case 'textarea': return <Textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'checkbox': return <Check label="" checked={!!value} onChange={onChange} />;
    case 'dropdown': return <Select value={value ?? ''} placeholder="Select" onChange={(e) => onChange(e.target.value)} options={f.options.map((o: string) => ({ value: o, label: o }))} />;
    case 'lookup_customer': return <Combo options={customers.map((c) => ({ value: c.id, label: c.name }))} value={value} onChange={onChange} />;
    case 'lookup_vendor': return <Combo options={vendors.map((c) => ({ value: c.id, label: c.name }))} value={value} onChange={onChange} />;
    case 'lookup_item': return <Combo options={items.map((c) => ({ value: c.id, label: c.name }))} value={value} onChange={onChange} />;
    default: return <Input type={f.type === 'date' ? 'date' : ['number', 'decimal', 'currency'].includes(f.type) ? 'number' : f.type === 'email' ? 'email' : 'text'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

export default function Custom() {
  const { key = '' } = useParams();
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const { data, error, loading, reload } = useApi<any>(`/custom/${key}?search=${encodeURIComponent(q)}`);
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  const can = useCan();
  if (loading && !data) return <Spinner />;
  if (error || !data) return <div className="p-6"><ErrorBox error={error} /></div>;
  const m = data.module;
  const show = (f: any, v: any) => (v == null || v === '' ? '' : f.type === 'checkbox' ? (v ? 'Yes' : 'No') : f.type === 'date' ? date(v) : f.type === 'currency' ? money(v) : String(v));
  return (
    <div>
      <PageHeader title={m.plural} actions={can('custom', 'create') && <button className="btn btn-primary" onClick={() => setEdit({ data: {} })}><Plus className="h-4 w-4" />New {m.name}</button>} />
      <div className="space-y-3 p-5">
        <Input className="w-72" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search records" />
        <DataTable exportName={m.key} rows={data.rows} onRow={(r) => setEdit(r)} cols={[
          { key: 'number', label: '#', render: (r) => <span className="link">{r.number}</span> },
          ...m.fields.slice(0, 6).map((f: any) => ({ key: f.key, label: f.label, render: (r: any) => show(f, r.data[f.key]), csv: (r: any) => r.data[f.key] })),
          { key: 'created_at', label: 'Created', render: (r) => dateTime(r.created_at) },
        ]} />
      </div>
      {edit && (
        <Modal wide title={edit.id ? `${m.name} ${edit.number}` : `New ${m.name}`} onClose={() => setEdit(null)} footer={<>
          {edit.id && can('custom', 'delete') && <button className="btn btn-danger mr-auto" onClick={async () => { if (await run(() => del(`/custom/${key}/${edit.id}`), 'Deleted')) { setEdit(null); reload(); } }}>Delete</button>}
          <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (edit.id ? put(`/custom/${key}/${edit.id}`, edit.data) : post(`/custom/${key}`, edit.data)), 'Saved')) { setEdit(null); reload(); } }}>Save</button></>}>
          <div className="grid gap-3 sm:grid-cols-2">
            {m.fields.map((f: any) => <Field key={f.key} label={f.label} required={!!f.required}><FieldInput f={f} value={edit.data[f.key]} onChange={(v) => setEdit({ ...edit, data: { ...edit.data, [f.key]: v } })} /></Field>)}
          </div>
        </Modal>
      )}
    </div>
  );
}
