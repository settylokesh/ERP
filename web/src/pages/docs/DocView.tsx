import { ArrowLeft, ChevronDown, Copy, CreditCard, Pencil, Printer, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, post } from '../../api';
import { AccountPicker } from '../../components/pickers';
import { Badge, Check, Confirm, ErrorBox, Field, Input, KeyVal, Modal, PageHeader, Select, Spinner, Tabs, Textarea, useAction } from '../../components/ui';
import { date, dateTime, money, qty, titleCase, today } from '../../lib/format';
import { useApi, useCan, useMeta } from '../../lib/hooks';
import PrintDoc from './PrintDoc';

type F = { key: string; label: string; type?: string; options?: { value: string; label: string }[]; def?: any; hint?: string };
const ACTION_FORMS: Record<string, F[]> = {
  ship: [{ key: 'date', label: 'Shipment date', type: 'date', def: today() }, { key: 'carrier', label: 'Carrier' }, { key: 'tracking_no', label: 'Tracking #' }, { key: 'charges', label: 'Shipping charges', type: 'number' }],
  deliver: [{ key: 'date', label: 'Delivered on', type: 'date', def: today() }],
  mark_transferred: [{ key: 'date', label: 'Received on', type: 'date', def: today() }],
  receive_return: [{ key: 'date', label: 'Received on', type: 'date', def: today() }],
  void: [{ key: 'reason', label: 'Reason for voiding', type: 'textarea' }],
  approve: [{ key: 'comment', label: 'Comment (optional)', type: 'textarea' }],
  reject: [{ key: 'comment', label: 'Reason for rejection', type: 'textarea' }],
  email: [{ key: 'to', label: 'To (leave blank for the contact email)' }],
  einvoice_cancel: [{ key: 'reason_code', label: 'Reason', type: 'select', def: '2', options: [{ value: '1', label: 'Duplicate' }, { value: '2', label: 'Data entry mistake' }, { value: '3', label: 'Order cancelled' }, { value: '4', label: 'Others' }] }, { key: 'remarks', label: 'Remarks' }],
  eway_generate: [
    { key: 'distance', label: 'Approximate distance (km)', type: 'number' },
    { key: 'transport_mode', label: 'Mode', type: 'select', def: 'road', options: [{ value: 'road', label: 'Road' }, { value: 'rail', label: 'Rail' }, { value: 'air', label: 'Air' }, { value: 'ship', label: 'Ship' }] },
    { key: 'vehicle_no', label: 'Vehicle number (Part-B)', hint: 'e.g. KA01AB1234' }, { key: 'transporter_id', label: 'Transporter ID (GSTIN/TRANSIN)' },
    { key: 'transporter_name', label: 'Transporter name' }, { key: 'transport_doc_no', label: 'Transport doc # (rail/air/ship)' },
    { key: 'odc', label: 'Over-dimensional cargo', type: 'check' }, { key: 'force', label: 'Generate even if below the threshold', type: 'check' },
  ],
  eway_update_vehicle: [{ key: 'vehicle_no', label: 'New vehicle number' }, { key: 'reason', label: 'Reason', type: 'select', def: 'Transhipment', options: ['Breakdown', 'Transhipment', 'Others'].map((x) => ({ value: x, label: x })) }],
  eway_cancel: [{ key: 'reason', label: 'Reason', type: 'select', def: 'Data entry mistake', options: ['Duplicate', 'Order cancelled', 'Data entry mistake', 'Others'].map((x) => ({ value: x, label: x })) }],
};
const CONFIRM_ONLY = new Set(['submit', 'mark_accepted', 'mark_declined', 'close', 'reopen', 'cancel', 'unship', 'mark_delivered', 'mark_returned', 'einvoice_generate', 'publish', 'close_bidding', 'create_pos', 'start_count']);

function ActionModal({ action, label, doc, onDone, onClose }: { action: string; label: string; doc: any; onDone: (r: any) => void; onClose: () => void }) {
  const fields = ACTION_FORMS[action] ?? [];
  const [body, setBody] = useState<any>(Object.fromEntries(fields.filter((f) => f.def !== undefined).map((f) => [f.key, f.def])));
  const { run, busy } = useAction();
  const go = async () => {
    const r = await run(() => post(`/docs/${doc.type}/${doc.id}/actions/${action}`, body), `${label} done`);
    if (r) onDone(r);
  };
  if (CONFIRM_ONLY.has(action)) {
    return <Confirm title={label} message={<>Proceed with <b>{label.toLowerCase()}</b> for {doc.number}?</>} confirmLabel={busy ? 'Working…' : label} onConfirm={go} onClose={onClose} danger={['cancel', 'mark_returned'].includes(action)} />;
  }
  return (
    <Modal title={`${label} — ${doc.number}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className={`btn ${action === 'void' || action === 'reject' ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={go}>{label}</button></>}>
      <div className="space-y-3">
        {fields.map((f) => (
          <Field key={f.key} label={f.type === 'check' ? '' : f.label} hint={f.hint}>
            {f.type === 'textarea' ? <Textarea value={body[f.key] ?? ''} onChange={(e) => setBody({ ...body, [f.key]: e.target.value })} />
              : f.type === 'select' ? <Select value={body[f.key] ?? ''} options={f.options!} onChange={(e) => setBody({ ...body, [f.key]: e.target.value })} />
              : f.type === 'check' ? <Check label={f.label} checked={!!body[f.key]} onChange={(v) => setBody({ ...body, [f.key]: v })} />
              : <Input type={f.type ?? 'text'} value={body[f.key] ?? ''} onChange={(e) => setBody({ ...body, [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value })} />}
          </Field>
        ))}
      </div>
    </Modal>
  );
}

function ApplyCredits({ doc, onDone, onClose }: { doc: any; onDone: () => void; onClose: () => void }) {
  const kind = doc.type === 'vendor_credit' ? 'made' : 'received';
  const { data } = useApi<any[]>(`/contacts/${doc.contact_id}/open-documents?kind=${kind}`);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const { run, busy } = useAction();
  const available = doc.type === 'retainer_invoice' ? doc.credit_available : doc.balance;
  const used = Object.values(amounts).reduce((a, v) => a + (Number(v) || 0), 0);
  const targets = (data ?? []).filter((d) => d.type !== 'retainer_invoice');
  return (
    <Modal wide title={`Apply credits from ${doc.number}`} onClose={onClose}
      footer={<><span className="mr-auto text-xs text-slate-500">Available {money(available)} · Applying {money(used)}</span><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || used <= 0 || used > available + 0.001} onClick={async () => {
          if (await run(() => post(`/docs/${doc.type}/${doc.id}/actions/apply_credits`, { allocations: Object.entries(amounts).map(([id, a]) => ({ document_id: Number(id), amount: Number(a) })).filter((x) => x.amount > 0) }), 'Credits applied')) onDone();
        }}>Apply</button></>}>
      {targets.length === 0 ? <div className="text-slate-500">No open {kind === 'made' ? 'bills' : 'invoices'} for this contact.</div> : (
        <table className="table">
          <thead><tr><th>Number</th><th>Date</th><th className="num">Balance</th><th className="num w-40">Amount to apply</th></tr></thead>
          <tbody>{targets.map((t) => (
            <tr key={t.id}><td>{t.number}</td><td>{date(t.date)}</td><td className="num">{money(t.balance)}</td>
              <td><input className="input text-right" type="number" value={amounts[t.id] ?? ''} onChange={(e) => setAmounts({ ...amounts, [t.id]: e.target.value })} aria-label={`Amount for ${t.number}`} /></td></tr>
          ))}</tbody>
        </table>
      )}
    </Modal>
  );
}

function RefundModal({ doc, onDone, onClose }: { doc: any; onDone: () => void; onClose: () => void }) {
  const [f, setF] = useState<any>({ amount: doc.balance, date: today(), mode: 'bank_transfer' });
  const { run, busy } = useAction();
  return (
    <Modal title={`Refund — ${doc.number}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => post('/refunds', { ...f, credit_doc_id: doc.id }), 'Refund recorded')) onDone(); }}>Save</button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount"><Input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: Number(e.target.value) })} /></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label={doc.type === 'vendor_credit' ? 'Deposit To' : 'Paid Through'} className="sm:col-span-2"><AccountPicker value={f.account_id} onChange={(v) => setF({ ...f, account_id: v })} types={['bank', 'cash', 'credit_card']} /></Field>
        <Field label="Reference"><Input value={f.reference ?? ''} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function RecordBid({ doc, onDone, onClose }: { doc: any; onDone: () => void; onClose: () => void }) {
  const { data: vendors } = useApi<any[]>('/contacts?kind=vendor');
  const invited = (vendors ?? []).filter((v) => (doc.data.vendor_ids ?? []).includes(v.id));
  const [vendor, setVendor] = useState<number | null>(null);
  const [rates, setRates] = useState<Record<number, { rate?: string; lead_days?: string }>>({});
  const { run, busy } = useAction();
  return (
    <Modal wide title="Record vendor bid (surrogate)" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !vendor} onClick={async () => {
        const bids = Object.entries(rates).filter(([, v]) => Number(v.rate) > 0).map(([line_id, v]) => ({ line_id: Number(line_id), rate: Number(v.rate), lead_days: v.lead_days ? Number(v.lead_days) : null }));
        if (await run(() => post(`/docs/rfq/${doc.id}/actions/record_bid`, { vendor_id: vendor, bids }), 'Bid recorded')) onDone();
      }}>Save bid</button></>}>
      <Field label="Vendor"><Select value={vendor ?? ''} placeholder="Select an invited vendor" options={invited.map((v) => ({ value: v.id, label: v.name }))} onChange={(e) => setVendor(Number(e.target.value) || null)} /></Field>
      <table className="table mt-3">
        <thead><tr><th>Item</th><th className="num">Qty</th><th className="num w-36">Unit price</th><th className="num w-28">Lead days</th></tr></thead>
        <tbody>{doc.lines.map((l: any) => (
          <tr key={l.id}><td>{l.item_name ?? l.description}</td><td className="num">{qty(l.qty)}</td>
            <td><input className="input text-right" type="number" value={rates[l.id]?.rate ?? ''} onChange={(e) => setRates({ ...rates, [l.id]: { ...rates[l.id], rate: e.target.value } })} aria-label="Bid rate" /></td>
            <td><input className="input text-right" type="number" value={rates[l.id]?.lead_days ?? ''} onChange={(e) => setRates({ ...rates, [l.id]: { ...rates[l.id], lead_days: e.target.value } })} aria-label="Lead days" /></td></tr>
        ))}</tbody>
      </table>
    </Modal>
  );
}

function BidsTab({ doc, reload }: { doc: any; reload: () => void }) {
  const vendors = [...new Map(doc.bids.map((b: any) => [b.vendor_id, b.vendor_name])).entries()];
  const [award, setAward] = useState<Record<number, number>>(() => Object.fromEntries(doc.bids.filter((b: any) => b.awarded).map((b: any) => [b.line_id, b.vendor_id])));
  const { run, busy } = useAction();
  if (!vendors.length) return <div className="p-6 text-slate-500">No bids recorded yet.</div>;
  return (
    <div className="card overflow-x-auto p-4">
      <table className="table">
        <thead><tr><th>Item</th><th className="num">Qty</th>{vendors.map(([id, n]) => <th key={id as number} className="num">{n as string}</th>)}<th>Award to</th></tr></thead>
        <tbody>{doc.lines.map((l: any) => {
          const lineBids = doc.bids.filter((b: any) => b.line_id === l.id);
          const min = Math.min(...lineBids.map((b: any) => b.rate));
          return (
            <tr key={l.id}><td>{l.item_name ?? l.description}</td><td className="num">{qty(l.qty)}</td>
              {vendors.map(([vid]) => {
                const b = lineBids.find((x: any) => x.vendor_id === vid);
                return <td key={vid as number} className={`num ${b && b.rate === min ? 'font-semibold text-emerald-700' : ''}`}>{b ? <>{money(b.rate)}<div className="text-[10px] text-slate-500">{b.lead_days ? `${b.lead_days} days` : ''}{b.awarded ? ' · awarded' : ''}</div></> : '-'}</td>;
              })}
              <td><select className="input" value={award[l.id] ?? ''} onChange={(e) => setAward({ ...award, [l.id]: Number(e.target.value) })} aria-label="Award vendor">
                <option value="">—</option>{lineBids.map((b: any) => <option key={b.vendor_id} value={b.vendor_id}>{b.vendor_name}</option>)}</select></td></tr>
          );
        })}</tbody>
      </table>
      {['open', 'closed', 'awarded'].includes(doc.status) && (
        <div className="mt-3 flex gap-2">
          <button className="btn" disabled={busy} onClick={async () => { if (await run(() => post(`/docs/rfq/${doc.id}/actions/award`, { lowest: true }), 'Awarded to lowest bids')) reload(); }}>Award lowest bids</button>
          <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => post(`/docs/rfq/${doc.id}/actions/award`, { awards: Object.entries(award).filter(([, v]) => v).map(([line_id, vendor_id]) => ({ line_id: Number(line_id), vendor_id })) }), 'Award saved')) reload(); }}>Save award</button>
        </div>
      )}
    </div>
  );
}

function CompleteCount({ doc, onDone, onClose }: { doc: any; onDone: () => void; onClose: () => void }) {
  const [counts, setCounts] = useState<Record<number, string>>(Object.fromEntries(doc.lines.map((l: any) => [l.id, l.qty2 ?? ''])));
  const { run, busy } = useAction();
  return (
    <Modal wide title="Enter counted quantities" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={async () => {
      if (await run(() => post(`/docs/stock_count/${doc.id}/actions/complete_count`, { counts: Object.entries(counts).map(([line_id, counted]) => ({ line_id: Number(line_id), counted: Number(counted) })) }), 'Count completed')) onDone();
    }}>Complete count</button></>}>
      <table className="table"><thead><tr><th>Item</th><th className="num">Expected</th><th className="num w-36">Counted</th><th className="num">Variance</th></tr></thead>
        <tbody>{doc.lines.map((l: any) => (
          <tr key={l.id}><td>{l.item_name}</td><td className="num">{qty(l.qty)}</td>
            <td><input className="input text-right" type="number" value={counts[l.id] ?? ''} onChange={(e) => setCounts({ ...counts, [l.id]: e.target.value })} aria-label="Counted" /></td>
            <td className={`num ${Number(counts[l.id]) - l.qty ? 'text-amber-700' : ''}`}>{counts[l.id] === '' ? '-' : qty(Number(counts[l.id]) - l.qty)}</td></tr>
        ))}</tbody></table>
    </Modal>
  );
}

function Dropdown({ label, children, icon }: { label: string; children: React.ReactNode; icon?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button className="btn" onClick={() => setOpen(!open)}>{icon}{label}<ChevronDown className="h-3.5 w-3.5" /></button>
      {open && <div className="card absolute right-0 top-9 z-30 min-w-[220px] py-1" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}
const MenuItem = ({ onClick, children, danger }: { onClick: () => void; children: React.ReactNode; danger?: boolean }) => (
  <button className={`block w-full px-3 py-1.5 text-left text-[13px] hover:bg-slate-50 ${danger ? 'text-red-600' : ''}`} onClick={onClick}>{children}</button>
);

export default function DocView() {
  const { type = '', id } = useParams();
  const nav = useNavigate();
  const { meta } = useMeta();
  const can = useCan();
  const { data: doc, error, loading, reload, setData } = useApi<any>(`/docs/${type}/${id}`);
  const [tab, setTab] = useState('doc');
  const [action, setAction] = useState<{ key: string; label: string } | null>(null);
  const [special, setSpecial] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [comment, setComment] = useState('');
  const { run } = useAction();
  if (loading && !doc) return <Spinner />;
  if (error || !doc) return <div className="p-6"><ErrorBox error={error ?? 'Not found'} /></div>;
  const def = meta.doc_types[type];
  const targets = Object.values(meta.doc_types).filter((t: any) => t.from.includes(type)) as any[];
  const editable = !['void', 'closed', 'invoiced', 'ordered', 'transferred', 'completed', 'credited', 'cancelled', 'adjusted', 'paid'].includes(doc.status) && doc.data?.einvoice?.status !== 'generated' && can(def.module, 'edit');
  const after = (r?: any) => { setAction(null); setSpecial(null); if (r?.document) setData(r.document); else reload(); };
  const actions = (doc.actions ?? []) as { key: string; label: string }[];
  const primary = actions.filter((a) => ['submit', 'approve', 'ship', 'deliver', 'mark_transferred', 'receive_return', 'publish', 'start_count', 'complete_count', 'create_pos'].includes(a.key));
  const secondary = actions.filter((a) => !primary.includes(a) && a.key !== 'comment');
  const openAction = (a: { key: string; label: string }) => {
    if (['apply_credits', 'record_bid', 'complete_count'].includes(a.key)) setSpecial(a.key);
    else setAction(a);
  };
  const canConvert = (t: any) => {
    if (['draft', 'void', 'pending_approval', 'rejected', 'cancelled'].includes(doc.status)) return false;
    if (t.type === 'sales_return' && type === 'sales_order' && doc.fulfil_status === 'pending') return false;
    return can(t.module, 'create');
  };
  return (
    <div className="pb-10">
      <PageHeader
        back={<Link to={`/docs/${type}`} className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />{def.plural}</Link>}
        title={<span className="flex flex-wrap items-center gap-2">{doc.number}<Badge status={doc.display_status} label={def.statuses[doc.display_status]} />{doc.fulfil_status && <Badge status={doc.fulfil_status} />}{doc.billing_status && <Badge status={doc.billing_status} />}</span>}
        subtitle={doc.contact ? <Link to={`/${doc.contact.kind === 'customer' ? 'customers' : 'vendors'}/${doc.contact.id}`}>{doc.contact.name}</Link> : doc.warehouse_name}
        actions={<>
          {editable && <Link to={`/docs/${type}/${id}/edit`} className="btn no-underline"><Pencil className="h-3.5 w-3.5" />Edit</Link>}
          <button className="btn" onClick={() => { setTab('doc'); setTimeout(() => window.print(), 50); }}><Printer className="h-3.5 w-3.5" />Print / PDF</button>
          {['invoice', 'retainer_invoice'].includes(type) && ['open', 'partially_paid'].includes(doc.status) && can('sales', 'create') && <Link className="btn btn-primary no-underline" to={`/payments/received/new?contact=${doc.contact_id}&doc=${doc.id}`}><CreditCard className="h-3.5 w-3.5" />Record Payment</Link>}
          {type === 'bill' && ['open', 'partially_paid'].includes(doc.status) && can('purchases', 'create') && <Link className="btn btn-primary no-underline" to={`/payments/made/new?contact=${doc.contact_id}&doc=${doc.id}`}><CreditCard className="h-3.5 w-3.5" />Record Payment</Link>}
          {primary.map((a) => <button key={a.key} className="btn btn-primary" onClick={() => openAction(a)}>{a.label}</button>)}
          {(targets.length > 0 || (type === 'sales_order' && doc.status === 'confirmed')) && (
            <Dropdown label="Create">
              {targets.filter(canConvert).map((t) => <MenuItem key={t.type} onClick={() => nav(`/docs/${t.type}/new?from=${doc.id}&from_type=${type}`)}>{t.label}</MenuItem>)}
              {type === 'sales_order' && doc.status === 'confirmed' && can('manufacturing', 'create') && <MenuItem onClick={async () => { const r = await run(() => post(`/manufacturing/orders/from-sales-order/${doc.id}`), 'Manufacturing orders created'); if (r) nav('/manufacturing/orders'); }}>Manufacturing Orders</MenuItem>}
              {targets.filter(canConvert).length === 0 && !(type === 'sales_order' && doc.status === 'confirmed') && <div className="px-3 py-1.5 text-xs text-slate-500">Submit the document first</div>}
            </Dropdown>
          )}
          <Dropdown label="More">
            {secondary.map((a) => <MenuItem key={a.key} onClick={() => openAction(a)} danger={a.key === 'void' || a.key === 'reject'}>{a.label}</MenuItem>)}
            {['credit_note', 'vendor_credit'].includes(type) && doc.status === 'open' && <MenuItem onClick={() => setSpecial('refund')}>Refund</MenuItem>}
            {can(def.module, 'create') && !['package', 'purchase_receive', 'sales_return'].includes(type) && <MenuItem onClick={() => nav(`/docs/${type}/new?clone=${doc.id}`)}><span className="inline-flex items-center gap-1"><Copy className="h-3.5 w-3.5" />Clone</span></MenuItem>}
            {can(def.module, 'delete') && <MenuItem danger onClick={() => setConfirmDelete(true)}><span className="inline-flex items-center gap-1"><Trash2 className="h-3.5 w-3.5" />Delete</span></MenuItem>}
          </Dropdown>
        </>} />
      <div className="px-5 pt-3">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'doc', label: def.label }, { key: 'related', label: `Related (${doc.related.length + doc.payments.length + doc.credits.length})` },
          ...(type === 'rfq' ? [{ key: 'bids', label: `Bids (${doc.bids.length})` }] : []),
          { key: 'journal', label: 'Journal' }, { key: 'stock', label: 'Stock' }, { key: 'history', label: 'History & Comments' },
        ]} />
      </div>
      <div className="space-y-4 p-5">
        {doc.status === 'pending_approval' && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800">
            Awaiting approval{doc.approval_level ? ` (level ${doc.approval_level + 1})` : ''}. {doc.can_approve ? 'You can approve or reject this document.' : 'You are not an approver for the current level.'}
          </div>
        )}
        {doc.data?.void_reason && <div className="rounded-md bg-slate-100 p-3 text-slate-600">Voided: {doc.data.void_reason}</div>}
        {tab === 'doc' && (
          <>
            {(doc.data?.einvoice || doc.data?.ewaybill || doc.data?.shipment) && (
              <div className="no-print grid gap-3 md:grid-cols-3">
                {doc.data?.einvoice && <div className="card p-3"><h3 className="mb-2">e-Invoice <Badge status={doc.data.einvoice.status} /></h3><KeyVal items={[['IRN', <span className="break-all text-[11px]">{doc.data.einvoice.irn}</span>], ['Ack No', doc.data.einvoice.ack_no], ['Ack Date', dateTime(doc.data.einvoice.ack_date)], ['Cancelled', doc.data.einvoice.cancel_reason]]} /></div>}
                {doc.data?.ewaybill && <div className="card p-3"><h3 className="mb-2">e-Way Bill <Badge status={doc.data.ewaybill.status} /></h3><KeyVal items={[['EWB No', doc.data.ewaybill.ewb_no], ['Valid until', doc.data.ewaybill.valid_until ? dateTime(doc.data.ewaybill.valid_until) : 'Part-B pending'], ['Distance', `${doc.data.ewaybill.distance} km`], ['Vehicle', doc.data.ewaybill.vehicle_no], ['Mode', titleCase(doc.data.ewaybill.transport_mode)]]} /></div>}
                {doc.data?.shipment && <div className="card p-3"><h3 className="mb-2">Shipment</h3><KeyVal items={[['Shipped on', date(doc.data.shipment.date)], ['Carrier', doc.data.shipment.carrier], ['Tracking #', doc.data.shipment.tracking_no], ['Delivered on', date(doc.data.delivered_on)]]} /></div>}
              </div>
            )}
            {['sales_order', 'purchase_order'].includes(type) && (
              <div className="no-print card overflow-x-auto p-3">
                <table className="table"><thead><tr><th>Item</th><th className="num">Ordered</th>
                  {type === 'sales_order' ? <><th className="num">Packed</th><th className="num">Invoiced</th></> : <><th className="num">Received</th><th className="num">Billed</th></>}</tr></thead>
                  <tbody>{doc.lines.map((l: any) => <tr key={l.id}><td>{l.item_name ?? l.description}</td><td className="num">{qty(l.qty)}</td>
                    {type === 'sales_order' ? <><td className="num">{qty(l.package_qty)}</td><td className="num">{qty(l.invoice_qty)}</td></> : <><td className="num">{qty(l.purchase_receive_qty)}</td><td className="num">{qty(l.bill_qty)}</td></>}</tr>)}</tbody></table>
              </div>
            )}
            {doc.type === 'retainer_invoice' && doc.credit_available > 0 && <div className="no-print rounded-md bg-emerald-50 p-3 text-emerald-800">Unused retainer credit: {money(doc.credit_available)}</div>}
            <PrintDoc doc={doc} />
          </>
        )}
        {tab === 'related' && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card p-4"><h3 className="mb-2">Linked transactions</h3>
              {doc.ref_doc && <div className="mb-2 text-xs">Created from <Link to={`/docs/${doc.ref_doc.type}/${doc.ref_doc.id}`}>{doc.ref_doc.number}</Link></div>}
              {doc.related.length === 0 ? <div className="text-slate-500">None</div> : <table className="table"><tbody>{doc.related.map((r: any) => (
                <tr key={r.id}><td><Link to={`/docs/${r.type}/${r.id}`}>{r.number}</Link><div className="text-[11px] text-slate-500">{meta.doc_types[r.type]?.label}</div></td><td>{date(r.date)}</td><td><Badge status={r.status} /></td><td className="num">{money(r.total)}</td></tr>
              ))}</tbody></table>}
            </div>
            <div className="card p-4"><h3 className="mb-2">Payments & credits</h3>
              {doc.payments.length + doc.credits.length + doc.refunds.length === 0 ? <div className="text-slate-500">None</div> : (
                <table className="table"><tbody>
                  {doc.payments.map((p: any) => <tr key={`p${p.id}`}><td><Link to={`/payments/${p.kind}/${p.id}`}>{p.number}</Link></td><td>{date(p.date)}</td><td>{titleCase(p.mode)}</td><td className="num">{money(p.amount)}</td></tr>)}
                  {doc.credits.map((c: any) => <tr key={`c${c.id}`}><td>{c.credit_number ?? c.payment_number ?? 'Credit'} → {c.document_number}</td><td>{date(c.date)}</td><td>Credit applied</td><td className="num">{money(c.amount)}
                    <button className="ml-2 text-xs text-red-600" onClick={async () => { if (await run(() => del(`/credits/${c.id}`), 'Credit removed')) reload(); }}>Remove</button></td></tr>)}
                  {doc.refunds.map((r: any) => <tr key={`r${r.id}`}><td>Refund</td><td>{date(r.date)}</td><td>{r.account_name}</td><td className="num">{money(r.amount)}<button className="ml-2 text-xs text-red-600" onClick={async () => { if (await run(() => del(`/refunds/${r.id}`), 'Refund deleted')) reload(); }}>Delete</button></td></tr>)}
                </tbody></table>
              )}
            </div>
          </div>
        )}
        {tab === 'bids' && <BidsTab doc={doc} reload={reload} />}
        {tab === 'journal' && (
          <div className="card overflow-x-auto p-4">
            {doc.journal.length === 0 ? <div className="text-slate-500">This transaction has no accounting impact in its current status.</div> : (
              <table className="table"><thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
                <tbody>{doc.journal.map((j: any, i: number) => <tr key={i}><td><Link to={`/accountant/accounts/${j.account_id}`}>{j.account_name}</Link>{j.description && <div className="text-[11px] text-slate-500">{j.description}</div>}</td><td className="num">{j.debit ? money(j.debit) : ''}</td><td className="num">{j.credit ? money(j.credit) : ''}</td></tr>)}</tbody>
                <tfoot><tr><td className="font-semibold">Total</td><td className="num font-semibold">{money(doc.journal.reduce((a: number, j: any) => a + j.debit, 0))}</td><td className="num font-semibold">{money(doc.journal.reduce((a: number, j: any) => a + j.credit, 0))}</td></tr></tfoot></table>
            )}
          </div>
        )}
        {tab === 'stock' && (
          <div className="card overflow-x-auto p-4">
            {doc.stock_moves.length === 0 ? <div className="text-slate-500">No stock movement in the current status.</div> : (
              <table className="table"><thead><tr><th>Date</th><th>Item</th><th>Warehouse</th><th>Type</th><th>Batch/Serial</th><th className="num">Qty</th><th className="num">Value</th><th>Affects</th></tr></thead>
                <tbody>{doc.stock_moves.map((m: any) => <tr key={m.id}><td>{date(m.date)}</td><td>{m.item_name}</td><td>{m.warehouse_name}</td><td>{titleCase(m.kind)}</td><td>{m.batch_no ?? m.serial_no ?? ''}</td><td className={`num ${m.qty < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{qty(m.qty)}</td><td className="num">{m.accounting ? money(m.value) : '-'}</td>
                  <td className="text-xs">{[m.physical && 'Physical', m.accounting && 'Accounting'].filter(Boolean).join(' + ')}</td></tr>)}</tbody></table>
            )}
          </div>
        )}
        {tab === 'history' && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card p-4"><h3 className="mb-2">Comments</h3>
              <div className="space-y-2">{doc.comments.map((c: any) => <div key={c.id} className="rounded bg-slate-50 p-2"><div className="text-[11px] text-slate-500">{c.user_name} · {dateTime(c.at)}</div>{c.body}</div>)}</div>
              <div className="mt-3 flex gap-2"><Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment" />
                <button className="btn" onClick={async () => { if (await run(() => post(`/docs/${type}/${id}/actions/comment`, { body: comment }))) { setComment(''); reload(); } }}>Add</button></div>
              {doc.approvals.length > 0 && <><h3 className="mb-2 mt-4">Approval trail</h3>{doc.approvals.map((a: any) => <div key={a.id} className="text-xs"><Badge status={a.action === 'approved' ? 'approved' : a.action === 'rejected' ? 'rejected' : 'pending'} label={titleCase(a.action)} /> {a.user_name} · {dateTime(a.at)} {a.comment && `— ${a.comment}`}</div>)}</>}
            </div>
            <div className="card p-4"><h3 className="mb-2">Audit history</h3>
              <ul className="space-y-1.5">{doc.history.map((h: any, i: number) => <li key={i} className="text-xs"><span className="text-slate-500">{dateTime(h.at)}</span> · {h.summary} <span className="text-slate-500">— {h.user_name ?? 'system'}</span></li>)}</ul>
            </div>
          </div>
        )}
      </div>
      {action && <ActionModal action={action.key} label={action.label} doc={doc} onDone={after} onClose={() => setAction(null)} />}
      {special === 'apply_credits' && <ApplyCredits doc={doc} onDone={after} onClose={() => setSpecial(null)} />}
      {special === 'refund' && <RefundModal doc={doc} onDone={after} onClose={() => setSpecial(null)} />}
      {special === 'record_bid' && <RecordBid doc={doc} onDone={after} onClose={() => setSpecial(null)} />}
      {special === 'complete_count' && <CompleteCount doc={doc} onDone={after} onClose={() => setSpecial(null)} />}
      {confirmDelete && <Confirm danger title={`Delete ${def.label}`} message={`Delete ${doc.number}? Its stock movements and journal entries are removed. This cannot be undone.`} confirmLabel="Delete"
        onClose={() => setConfirmDelete(false)} onConfirm={async () => { setConfirmDelete(false); if (await run(() => del(`/docs/${type}/${id}`), 'Deleted')) nav(`/docs/${type}`); }} />}
    </div>
  );
}
