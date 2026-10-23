import { ArrowLeft, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { del, get, post, put } from '../api';
import { DataTable } from '../components/DataTable';
import { AccountPicker, ContactPicker } from '../components/pickers';
import { Confirm, ErrorBox, Field, Input, KeyVal, Modal, PageHeader, Select, Spinner, Textarea, useAction } from '../components/ui';
import { date, money, titleCase, today } from '../lib/format';
import { useApi, useCan } from '../lib/hooks';

const MODES = ['bank_transfer', 'neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash', 'card', 'other'];

function List() {
  const { kind = 'received' } = useParams();
  const { data, loading, error } = useApi<any>(`/payments/${kind}`);
  const nav = useNavigate();
  const can = useCan();
  const mod = kind === 'made' ? 'purchases' : 'sales';
  return (
    <div>
      <PageHeader title={kind === 'made' ? 'Payments Made' : 'Payments Received'} actions={can(mod, 'create') && <Link to={`/payments/${kind}/new`} className="btn btn-primary no-underline"><Plus className="h-4 w-4" />New</Link>} />
      <div className="p-5">
        <ErrorBox error={error} />
        {loading && !data ? <Spinner /> : (
          <DataTable exportName={`payments_${kind}`} rows={data?.rows ?? []} onRow={(r) => nav(`/payments/${kind}/${r.id}`)} cols={[
            { key: 'date', label: 'Date', render: (r) => date(r.date) }, { key: 'number', label: 'Payment #', render: (r) => <span className="link">{r.number}</span> },
            { key: 'reference', label: 'Reference' }, { key: 'contact_name', label: kind === 'made' ? 'Vendor' : 'Customer' },
            { key: 'mode', label: 'Mode', render: (r) => titleCase(r.mode) }, { key: 'account_name', label: kind === 'made' ? 'Paid Through' : 'Deposit To' },
            { key: 'amount', label: 'Amount', num: true, render: (r) => money(r.amount) }, { key: 'unused', label: 'Unused', num: true, render: (r) => money(r.unused) },
          ]} />
        )}
      </div>
    </div>
  );
}

function Form() {
  const { kind = 'received', id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { run, busy } = useAction();
  const [f, setF] = useState<any>(id ? null : { date: today(), mode: 'bank_transfer', contact_id: sp.get('contact') ? Number(sp.get('contact')) : null, amount: '', bank_charges: 0, tds_amount: 0 });
  const [alloc, setAlloc] = useState<Record<number, string>>({});
  const [open, setOpen] = useState<any[]>([]);
  useEffect(() => {
    if (id) get(`/payments/${kind}/${id}`).then((p) => { setF(p); setAlloc(Object.fromEntries(p.allocations.map((a: any) => [a.document_id, String(a.amount)]))); });
  }, [id, kind]);
  useEffect(() => {
    if (!f?.contact_id) { setOpen([]); return; }
    get(`/contacts/${f.contact_id}/open-documents?kind=${kind}`).then((docs: any[]) => {
      setOpen(docs);
      const pre = sp.get('doc');
      if (pre && !id) {
        const d = docs.find((x) => x.id === Number(pre));
        if (d) { setAlloc({ [d.id]: String(d.balance) }); setF((x: any) => ({ ...x, amount: d.balance })); }
      }
    });
  }, [f?.contact_id, kind, sp, id]);
  if (!f) return <Spinner />;
  const set = (p: any) => setF({ ...f, ...p });
  // When editing, add the payment's own existing allocations back into each document's balance.
  const docs = [...open, ...(f.allocations ?? []).filter((a: any) => !open.some((o) => o.id === a.document_id)).map((a: any) => ({ id: a.document_id, number: a.number, date: a.date, type: a.type, total: a.total, balance: 0 }))];
  const mine = (docId: number) => Number((f.allocations ?? []).find((a: any) => a.document_id === docId)?.amount ?? 0);
  const allocated = Object.values(alloc).reduce((a, v) => a + (Number(v) || 0), 0);
  const autoAllocate = () => {
    let left = (Number(f.amount) || 0) + (Number(f.tds_amount) || 0);
    const next: Record<number, string> = {};
    for (const d of docs) {
      const bal = d.balance + mine(d.id);
      const take = Math.min(bal, left);
      if (take > 0) { next[d.id] = String(Math.round(take * 100) / 100); left -= take; }
    }
    setAlloc(next);
  };
  const save = async () => {
    const body = { ...f, amount: Number(f.amount), allocations: Object.entries(alloc).map(([document_id, amount]) => ({ document_id: Number(document_id), amount: Number(amount) })).filter((a) => a.amount > 0) };
    const r = await run(() => (id ? put(`/payments/${kind}/${id}`, body) : post(`/payments/${kind}`, body)), 'Payment saved');
    if (r) nav(`/payments/${kind}/${r.id}`);
  };
  return (
    <div className="pb-20">
      <PageHeader title={`${id ? 'Edit' : 'Record'} ${kind === 'made' ? 'Payment Made' : 'Payment Received'}`} back={<Link to={`/payments/${kind}`} className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />Payments</Link>} />
      <div className="space-y-5 p-5">
        <div className="card grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={kind === 'made' ? 'Vendor' : 'Customer'} required><ContactPicker kind={kind === 'made' ? 'vendor' : 'customer'} value={f.contact_id} onChange={(v) => { set({ contact_id: v }); setAlloc({}); }} disabled={!!id} /></Field>
          <Field label="Amount" required><Input type="number" value={f.amount} onChange={(e) => set({ amount: e.target.value })} /></Field>
          <Field label="Payment Date"><Input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></Field>
          <Field label="Payment Mode"><Select value={f.mode} onChange={(e) => set({ mode: e.target.value })} options={MODES.map((m) => ({ value: m, label: titleCase(m).replace('Upi', 'UPI').replace('Neft', 'NEFT').replace('Rtgs', 'RTGS').replace('Imps', 'IMPS') }))} /></Field>
          <Field label={kind === 'made' ? 'Paid Through' : 'Deposit To'} required><AccountPicker value={f.account_id} onChange={(v) => set({ account_id: v })} types={['bank', 'cash', 'credit_card', 'other_current_asset']} /></Field>
          <Field label="Reference #"><Input value={f.reference ?? ''} onChange={(e) => set({ reference: e.target.value })} /></Field>
          <Field label="Bank Charges"><Input type="number" value={f.bank_charges ?? 0} onChange={(e) => set({ bank_charges: Number(e.target.value) })} /></Field>
          {kind === 'received' && <Field label="TDS deducted by customer"><Input type="number" value={f.tds_amount ?? 0} onChange={(e) => set({ tds_amount: Number(e.target.value) })} /></Field>}
          <Field label="Notes" className="sm:col-span-2 lg:col-span-1"><Textarea rows={1} value={f.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} /></Field>
        </div>
        {f.contact_id && (
          <div className="card p-4">
            <div className="mb-2 flex items-center justify-between"><h3>Unpaid {kind === 'made' ? 'bills' : 'invoices'}</h3><button className="btn btn-sm" onClick={autoAllocate}>Allocate automatically</button></div>
            {docs.length === 0 ? <div className="text-slate-500">No unpaid documents. The full amount will be kept as an advance / credit.</div> : (
              <table className="table"><thead><tr><th>Date</th><th>Number</th><th className="num">Amount</th><th className="num">Amount Due</th><th className="num w-44">Payment</th></tr></thead>
                <tbody>{docs.map((d) => (
                  <tr key={d.id}><td>{date(d.date)}</td><td>{d.number}{d.type === 'retainer_invoice' && <span className="ml-1 text-xs text-slate-500">(retainer)</span>}</td><td className="num">{money(d.total)}</td><td className="num">{money(d.balance + mine(d.id))}</td>
                    <td><Input type="number" className="text-right" value={alloc[d.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [d.id]: e.target.value })} aria-label={`Payment for ${d.number}`} /></td></tr>
                ))}</tbody></table>
            )}
            <div className="mt-3 flex justify-end gap-6 text-[13px]">
              <span>Amount received: <b>{money((Number(f.amount) || 0) + (Number(f.tds_amount) || 0))}</b></span>
              <span>Allocated: <b>{money(allocated)}</b></span>
              <span>Excess (credit): <b className={allocated > (Number(f.amount) || 0) + (Number(f.tds_amount) || 0) ? 'text-red-600' : ''}>{money((Number(f.amount) || 0) + (Number(f.tds_amount) || 0) - allocated)}</b></span>
            </div>
          </div>
        )}
      </div>
      <div className="no-print fixed bottom-0 left-0 right-0 flex gap-2 border-t bg-white px-5 py-3 lg:left-60"><button className="btn btn-primary" disabled={busy} onClick={save}>Save</button><button className="btn" onClick={() => nav(-1)}>Cancel</button></div>
    </div>
  );
}

function View() {
  const { kind = 'received', id } = useParams();
  const { data: p, error, loading, reload } = useApi<any>(`/payments/${kind}/${id}`);
  const nav = useNavigate();
  const can = useCan();
  const mod = kind === 'made' ? 'purchases' : 'sales';
  const [delOpen, setDelOpen] = useState(false);
  const [refund, setRefund] = useState<any>(null);
  const [apply, setApply] = useState<Record<number, string> | null>(null);
  const { data: openDocs } = useApi<any[]>(apply && p ? `/contacts/${p.contact_id}/open-documents?kind=${kind}` : null);
  const { run, busy } = useAction();
  if (loading && !p) return <Spinner />;
  if (error || !p) return <div className="p-6"><ErrorBox error={error} /></div>;
  return (
    <div>
      <PageHeader title={`Payment ${p.number}`} subtitle={p.contact_name} back={<Link to={`/payments/${kind}`} className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />Payments</Link>}
        actions={<>
          {p.unused > 0 && <button className="btn" onClick={() => setApply({})}>Apply to {kind === 'made' ? 'bills' : 'invoices'}</button>}
          {p.unused > 0 && <button className="btn" onClick={() => setRefund({ amount: p.unused, date: today(), account_id: p.account_id })}>Refund</button>}
          {can(mod, 'edit') && <Link to={`/payments/${kind}/${id}/edit`} className="btn no-underline">Edit</Link>}
          {can(mod, 'delete') && <button className="btn" onClick={() => setDelOpen(true)}>Delete</button>}
        </>} />
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        <div className="card p-4"><h3 className="mb-2">Payment details</h3>
          <KeyVal items={[['Date', date(p.date)], ['Amount', money(p.amount)], ['Mode', titleCase(p.mode)], [kind === 'made' ? 'Paid through' : 'Deposited to', p.account_name], ['Reference', p.reference], ['Bank charges', p.bank_charges ? money(p.bank_charges) : null], ['TDS deducted', p.tds_amount ? money(p.tds_amount) : null], ['Unused amount', money(p.unused)], ['Notes', p.notes]]} />
        </div>
        <div className="card p-4"><h3 className="mb-2">Applied to</h3>
          <table className="table"><tbody>
            {p.allocations.map((a: any) => <tr key={a.id}><td><Link to={`/docs/${a.type}/${a.document_id}`}>{a.number}</Link></td><td>{date(a.date)}</td><td className="num">{money(a.amount)}</td></tr>)}
            {p.applications.map((a: any) => <tr key={`c${a.id}`}><td><Link to={`/docs/${a.type}/${a.document_id}`}>{a.number}</Link> <span className="text-xs text-slate-500">(credit)</span></td><td>{date(a.date)}</td><td className="num">{money(a.amount)}</td></tr>)}
            {p.refunds.map((r: any) => <tr key={`r${r.id}`}><td>Refund · {r.account_name}</td><td>{date(r.date)}</td><td className="num">{money(r.amount)}</td></tr>)}
          </tbody></table>
        </div>
        <div className="card p-4 lg:col-span-2"><h3 className="mb-2">Journal</h3>
          <table className="table"><thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>{p.journal.map((j: any, i: number) => <tr key={i}><td>{j.account_name}</td><td className="num">{j.debit ? money(j.debit) : ''}</td><td className="num">{j.credit ? money(j.credit) : ''}</td></tr>)}</tbody></table>
        </div>
      </div>
      {delOpen && <Confirm danger title="Delete payment" message={`Delete ${p.number}? Invoice balances will be restored.`} confirmLabel="Delete" onClose={() => setDelOpen(false)} onConfirm={async () => { setDelOpen(false); if (await run(() => del(`/payments/${kind}/${id}`), 'Payment deleted')) nav(`/payments/${kind}`); }} />}
      {refund && (
        <Modal title="Refund excess payment" onClose={() => setRefund(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => post('/refunds', { ...refund, payment_id: p.id }), 'Refund recorded')) { setRefund(null); reload(); } }}>Save</button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount"><Input type="number" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: Number(e.target.value) })} /></Field>
            <Field label="Date"><Input type="date" value={refund.date} onChange={(e) => setRefund({ ...refund, date: e.target.value })} /></Field>
            <Field label="Account" className="sm:col-span-2"><AccountPicker value={refund.account_id} onChange={(v) => setRefund({ ...refund, account_id: v })} types={['bank', 'cash', 'credit_card']} /></Field>
          </div>
        </Modal>
      )}
      {apply && (
        <Modal wide title="Apply unused amount" onClose={() => setApply(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => post('/credits/apply', { payment_id: p.id, allocations: Object.entries(apply).map(([d, a]) => ({ document_id: Number(d), amount: Number(a) })).filter((x) => x.amount > 0) }), 'Applied')) { setApply(null); reload(); } }}>Apply</button>}>
          <table className="table"><thead><tr><th>Number</th><th className="num">Balance</th><th className="num">Apply</th></tr></thead>
            <tbody>{(openDocs ?? []).filter((d) => d.type !== 'retainer_invoice').map((d) => <tr key={d.id}><td>{d.number}</td><td className="num">{money(d.balance)}</td><td><Input type="number" className="text-right" value={apply[d.id] ?? ''} onChange={(e) => setApply({ ...apply, [d.id]: e.target.value })} /></td></tr>)}</tbody></table>
          <div className="mt-2 text-xs text-slate-500">Available: {money(p.unused)}</div>
        </Modal>
      )}
    </div>
  );
}

export default function Payments() {
  return (
    <Routes>
      <Route index element={<List />} />
      <Route path="new" element={<Form />} />
      <Route path=":id" element={<View />} />
      <Route path=":id/edit" element={<Form />} />
    </Routes>
  );
}
