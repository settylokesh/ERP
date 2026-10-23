import { Download } from 'lucide-react';
import { useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { download, post } from '../api';
import { DataTable } from '../components/DataTable';
import { Badge, ErrorBox, Field, Input, PageHeader, Spinner, Stat, Tabs, Textarea, useAction } from '../components/ui';
import { date, dateTime, money } from '../lib/format';
import { useApi, useMeta } from '../lib/hooks';

const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };
const taxCols = [
  { key: 'txval', label: 'Taxable Value', num: true, render: (r: any) => money(r.txval) }, { key: 'iamt', label: 'IGST', num: true, render: (r: any) => money(r.iamt) },
  { key: 'camt', label: 'CGST', num: true, render: (r: any) => money(r.camt) }, { key: 'samt', label: 'SGST', num: true, render: (r: any) => money(r.samt) },
];
const sumItms = (r: any, k: string) => r.itms.reduce((a: number, i: any) => a + i[k], 0);
const invCols = (party: boolean) => [
  ...(party ? [{ key: 'ctin', label: 'GSTIN' }, { key: 'receiver', label: 'Receiver' }] : [{ key: 'pos', label: 'POS' }]),
  { key: 'inum', label: 'Invoice #', render: (r: any) => r.inum ?? r.nt_num }, { key: 'idt', label: 'Date', render: (r: any) => r.idt ?? r.nt_dt },
  { key: 'val', label: 'Value', num: true, render: (r: any) => money(r.val) },
  { key: 'txval', label: 'Taxable', num: true, render: (r: any) => money(sumItms(r, 'txval')) },
  { key: 'tax', label: 'Tax', num: true, render: (r: any) => money(r.itms.reduce((a: number, i: any) => a + (i.iamt ?? 0) + (i.camt ?? 0) + (i.samt ?? 0), 0)) },
];

function Gstr1() {
  const [period, setPeriod] = useState(prevMonth());
  const { data, error, loading } = useApi<any>(`/gst/gstr1?period=${period}`);
  const [tab, setTab] = useState('summary');
  return (
    <div>
      <PageHeader title="GSTR-1" subtitle="Details of outward supplies — generated from posted invoices and credit notes"
        actions={<><Input type="month" className="w-40" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Return period" /><button className="btn btn-primary" onClick={() => download(`/gst/gstr1/json?period=${period}`, `GSTR1_${period}.json`)}><Download className="h-4 w-4" />Download JSON</button></>} />
      <div className="px-5 pt-3"><Tabs active={tab} onChange={setTab} tabs={[{ key: 'summary', label: 'Summary' }, { key: 'b2b', label: `B2B (${data?.b2b.length ?? 0})` }, { key: 'b2cl', label: `B2CL (${data?.b2cl.length ?? 0})` }, { key: 'b2cs', label: `B2CS (${data?.b2cs.length ?? 0})` }, { key: 'exp', label: `Exports (${data?.exp.length ?? 0})` }, { key: 'cdn', label: `Credit/Debit Notes (${(data?.cdnr.length ?? 0) + (data?.cdnur.length ?? 0)})` }, { key: 'hsn', label: 'HSN Summary' }, { key: 'docs', label: 'Documents' }]} /></div>
      <div className="space-y-3 p-5">
        <ErrorBox error={error} />
        {!data || loading ? <Spinner /> : (
          <>
            {!data.gstin && <div className="rounded-md bg-amber-50 p-3 text-amber-800">Set your GSTIN in <Link to="/settings">Settings</Link> before filing.</div>}
            {tab === 'summary' && <DataTable rows={data.summary} cols={[{ key: 'section', label: 'Section' }, { key: 'count', label: 'Records', num: true }, ...taxCols]} />}
            {tab === 'b2b' && <DataTable rows={data.b2b} cols={[...invCols(true), { key: 'inv_typ', label: 'Type' }, { key: 'irn', label: 'IRN', render: (r: any) => (r.irn ? '✓' : '') }]} />}
            {tab === 'b2cl' && <DataTable rows={data.b2cl} cols={invCols(false)} />}
            {tab === 'b2cs' && <DataTable rows={data.b2cs} cols={[{ key: 'sply_ty', label: 'Supply' }, { key: 'pos', label: 'POS' }, { key: 'rt', label: 'Rate %', num: true }, ...taxCols]} />}
            {tab === 'exp' && <DataTable rows={data.exp} cols={[{ key: 'exp_typ', label: 'Type' }, ...invCols(false).slice(1)]} />}
            {tab === 'cdn' && <DataTable rows={[...data.cdnr, ...data.cdnur]} cols={[{ key: 'ctin', label: 'GSTIN', render: (r: any) => r.ctin ?? r.typ }, { key: 'nt_num', label: 'Note #' }, { key: 'nt_dt', label: 'Date' }, { key: 'orig_inum', label: 'Original invoice' }, { key: 'val', label: 'Value', num: true, render: (r: any) => money(r.val) }]} />}
            {tab === 'hsn' && <DataTable exportName={`hsn_${period}`} rows={data.hsn} cols={[{ key: 'section', label: 'Table', render: (r: any) => r.section.toUpperCase() }, { key: 'hsn_sc', label: 'HSN/SAC' }, { key: 'desc', label: 'Description' }, { key: 'uqc', label: 'UQC' }, { key: 'qty', label: 'Qty', num: true }, { key: 'rt', label: 'Rate %', num: true }, ...taxCols]} />}
            {tab === 'docs' && <DataTable rows={data.docs} cols={[{ key: 'doc_typ', label: 'Document type' }, { key: 'from', label: 'From' }, { key: 'to', label: 'To' }, { key: 'totnum', label: 'Total', num: true }, { key: 'cancel', label: 'Cancelled', num: true }, { key: 'net_issue', label: 'Net issued', num: true }]} />}
          </>
        )}
      </div>
    </div>
  );
}

function Gstr3b() {
  const [period, setPeriod] = useState(prevMonth());
  const { data, error, loading } = useApi<any>(`/gst/gstr3b?period=${period}`);
  return (
    <div>
      <PageHeader title="GSTR-3B" subtitle="Summary return with tax liability, input tax credit and set-off (Section 49 / Rule 88A)" actions={<Input type="month" className="w-40" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Return period" />} />
      <div className="space-y-4 p-5">
        <ErrorBox error={error} />
        {!data || loading ? <Spinner /> : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Output tax (forward charge)" value={money(data.liability.forward.igst + data.liability.forward.cgst + data.liability.forward.sgst)} />
              <Stat label="Eligible ITC" value={money(data.itc.iamt + data.itc.camt + data.itc.samt)} />
              <Stat label="Payable in cash" value={money(data.total_cash)} tone={data.total_cash > 0 ? 'warn' : 'good'} sub={`Due ${date(data.due_date)}`} />
              <Stat label="ITC carried forward" value={money(data.setoff.carry_forward.igst + data.setoff.carry_forward.cgst + data.setoff.carry_forward.sgst)} />
            </div>
            <div className="card p-4"><h3 className="mb-2">3.1 Outward supplies and inward supplies liable to reverse charge</h3><DataTable rows={data.table_3_1} cols={[{ key: 'row', label: 'Nature of supplies' }, ...taxCols]} /></div>
            <div className="card p-4"><h3 className="mb-2">3.2 Inter-state supplies to unregistered persons</h3><DataTable rows={data.table_3_2} cols={[{ key: 'state', label: 'Place of supply' }, { key: 'txval', label: 'Taxable value', num: true, render: (r: any) => money(r.txval) }, { key: 'iamt', label: 'IGST', num: true, render: (r: any) => money(r.iamt) }]} /></div>
            <div className="card p-4"><h3 className="mb-2">4. Eligible ITC</h3><DataTable rows={data.table_4} cols={[{ key: 'row', label: 'Details' }, ...taxCols.slice(1)]} /></div>
            <div className="card p-4"><h3 className="mb-2">5. Exempt, nil and non-GST inward supplies</h3><DataTable rows={data.table_5} cols={[{ key: 'row', label: 'Nature' }, { key: 'inter', label: 'Inter-state', num: true, render: (r: any) => money(r.inter) }, { key: 'intra', label: 'Intra-state', num: true, render: (r: any) => money(r.intra) }]} /></div>
            <div className="card overflow-x-auto p-4"><h3 className="mb-2">6.1 Payment of tax</h3>
              <table className="table"><thead><tr><th>Tax</th><th className="num">Liability</th><th className="num">Paid via IGST ITC</th><th className="num">Paid via CGST ITC</th><th className="num">Paid via SGST ITC</th><th className="num">RCM (cash)</th><th className="num">Cash payable</th></tr></thead>
                <tbody>{(['igst', 'cgst', 'sgst'] as const).map((h) => <tr key={h}><td className="uppercase">{h}</td><td className="num">{money(data.liability.forward[h] + data.liability.reverse_charge[h])}</td>
                  <td className="num">{money(data.setoff.used.igst[h])}</td><td className="num">{money(data.setoff.used.cgst[h])}</td><td className="num">{money(data.setoff.used.sgst[h])}</td><td className="num">{money(data.liability.reverse_charge[h])}</td><td className="num font-semibold">{money(data.cash_payable[h])}</td></tr>)}</tbody></table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Gstr2b() {
  const [period, setPeriod] = useState(prevMonth());
  const [text, setText] = useState('');
  const [result, setResult] = useState<any>(null);
  const { run, busy } = useAction();
  const parse = (): any[] => {
    const t = text.trim();
    if (!t) return [];
    if (t.startsWith('{') || t.startsWith('[')) {
      const j = JSON.parse(t);
      const b2b = j?.data?.docdata?.b2b ?? j?.b2b ?? j;
      if (Array.isArray(b2b) && b2b[0]?.inv) return b2b.flatMap((s: any) => s.inv.map((i: any) => ({ ctin: s.ctin, inum: i.inum, idt: i.dt ?? i.idt, txval: i.txval ?? i.items?.reduce((a: number, x: any) => a + (x.txval ?? 0), 0), iamt: i.igst ?? i.iamt ?? 0, camt: i.cgst ?? i.camt ?? 0, samt: i.sgst ?? i.samt ?? 0 })));
      return b2b;
    }
    const [head, ...rows] = t.split(/\r?\n/).map((l) => l.split(',').map((c) => c.trim()));
    return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.toLowerCase(), r[i]])));
  };
  return (
    <div>
      <PageHeader title="GSTR-2B Reconciliation" subtitle="Match the auto-drafted ITC statement against your recorded bills" />
      <div className="space-y-4 p-5">
        <div className="card space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-3"><Field label="Return period"><Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></Field></div>
          <Field label="Paste GSTR-2B JSON (from the GST portal) or CSV with columns ctin,inum,idt,txval,iamt,camt,samt"><Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <input type="file" accept=".json,.csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} aria-label="2B file" />
          <div><button className="btn btn-primary" disabled={busy || !text} onClick={async () => { let entries: any[]; try { entries = parse(); } catch { entries = []; } const r = await run(() => post('/gst/gstr2b/reconcile', { period, entries })); if (r) setResult(r); }}>Reconcile</button></div>
        </div>
        {result && (
          <>
            <div className="grid gap-3 sm:grid-cols-4"><Stat label="Matched" value={result.summary.matched} tone="good" /><Stat label="Mismatched" value={result.summary.mismatch} tone={result.summary.mismatch ? 'warn' : undefined} /><Stat label="In 2B, not in books" value={result.summary.missing_in_books} tone={result.summary.missing_in_books ? 'bad' : undefined} /><Stat label="In books, not in 2B" value={result.summary.missing_in_2b} tone={result.summary.missing_in_2b ? 'warn' : undefined} /></div>
            <DataTable exportName={`gstr2b_${period}`} rows={result.results} cols={[{ key: 'status', label: 'Status', render: (r: any) => <Badge status={r.status === 'matched' ? 'paid' : r.status === 'mismatch' ? 'partially_paid' : 'overdue'} label={r.status.replace(/_/g, ' ')} /> }, { key: 'ctin', label: 'Supplier GSTIN' }, { key: 'inum', label: 'Invoice #' }, { key: 'bill_number', label: 'Bill', render: (r: any) => (r.bill_id ? <Link to={`/docs/bill/${r.bill_id}`}>{r.bill_number}</Link> : '-') }, { key: 'txval', label: 'Taxable', num: true, render: (r: any) => money(r.txval) }, { key: 'differences', label: 'Differences', render: (r: any) => (r.differences ?? []).join('; ') }]} />
          </>
        )}
      </div>
    </div>
  );
}

function EInvoices() {
  const { data } = useApi<any[]>('/gst/einvoices');
  const { meta } = useMeta();
  const [filter, setFilter] = useState('');
  const rows = (data ?? []).filter((r) => !filter || (filter === 'pending' ? r.einvoice_status !== 'generated' : filter === 'irn' ? r.einvoice_status === 'generated' : r.ewaybill_status === 'generated'));
  return (
    <div>
      <PageHeader title="e-Invoices & e-Way Bills" subtitle={`IRP / NIC integration runs in sandbox mode (IRN computed per the e-invoice schema; no live GSP credentials). e-Way bill threshold ₹${meta.org.eway_threshold}.`} />
      <div className="space-y-3 p-5">
        <div className="flex gap-1">{[['', 'All'], ['pending', 'IRN pending'], ['irn', 'IRN generated'], ['ewb', 'e-Way bill active']].map(([k, l]) => <button key={k} className={`chip cursor-pointer px-3 py-1 ${filter === k ? 'bg-brand-600 text-white' : 'bg-white ring-1 ring-slate-200'}`} onClick={() => setFilter(k)}>{l}</button>)}</div>
        <DataTable exportName="einvoices" rows={rows} cols={[
          { key: 'date', label: 'Date', render: (r) => date(r.date) }, { key: 'number', label: 'Document', render: (r) => <Link to={`/docs/${r.type}/${r.id}`}>{r.number}</Link> },
          { key: 'contact_name', label: 'Customer' }, { key: 'gstin', label: 'GSTIN' }, { key: 'total', label: 'Value', num: true, render: (r) => money(r.total) },
          { key: 'einvoice_status', label: 'e-Invoice', render: (r) => (r.einvoice_status ? <Badge status={r.einvoice_status} /> : <span className="text-xs text-slate-400">-</span>) },
          { key: 'ack_no', label: 'Ack No' },
          { key: 'ewaybill_status', label: 'e-Way Bill', render: (r) => (r.ewaybill_status ? <span><Badge status={r.ewaybill_status} /> <span className="text-xs">{r.ewb_no}</span></span> : '-') },
          { key: 'ewb_valid_until', label: 'Valid until', render: (r) => (r.ewb_valid_until ? dateTime(r.ewb_valid_until) : '') },
        ]} />
      </div>
    </div>
  );
}

export default function Compliance() {
  return (
    <Routes>
      <Route path="gstr1" element={<Gstr1 />} />
      <Route path="gstr3b" element={<Gstr3b />} />
      <Route path="gstr2b" element={<Gstr2b />} />
      <Route path="einvoices" element={<EInvoices />} />
      <Route path="*" element={<Gstr1 />} />
    </Routes>
  );
}
