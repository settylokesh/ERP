import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { qs } from '../../api';
import { DataTable, type Col } from '../../components/DataTable';
import { Badge, ErrorBox, Input, PageHeader, Spinner } from '../../components/ui';
import { date, money } from '../../lib/format';
import { useApi, useCan, useDebounced, useMeta } from '../../lib/hooks';

const PAGE = 100;

export default function DocList() {
  const { type = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const { meta } = useMeta();
  const can = useCan();
  const def = meta.doc_types[type];
  const nav = useNavigate();
  const status = sp.get('status') ?? '';
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useDebounced(search);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [type, status, q, from, to]);
  const { data, error, loading } = useApi<{ rows: any[]; total: number }>(def ? `/docs/${type}${qs({ status, search: q, from, to, limit: PAGE, offset: page * PAGE })}` : null);
  if (!def) return <div className="p-6"><ErrorBox error={`Unknown module ${type}`} /></div>;
  const statusTabs = [{ k: '', l: 'All' }, ...Object.entries(def.statuses).map(([k, l]) => ({ k, l: l as string })), ...(['invoice', 'bill'].includes(type) ? [{ k: 'overdue', l: 'Overdue' }, { k: 'unpaid', l: 'Unpaid' }] : [])];
  const cols: Col<any>[] = [
    { key: 'date', label: 'Date', render: (r) => date(r.date), csv: (r) => r.date },
    { key: 'number', label: `${def.label}#`, render: (r) => <span className="link font-medium">{r.number}</span> },
    { key: 'reference', label: 'Reference', render: (r) => r.reference ?? '' },
    ...(def.party ? [{ key: 'contact_name', label: def.party === 'vendor' ? 'Vendor Name' : 'Customer Name' }] : []),
    ...(['transfer_order'].includes(type) ? [{ key: 'warehouse_name', label: 'From' }] : []),
    { key: 'status', label: 'Status', render: (r) => (
      <div className="flex flex-wrap gap-1">
        <Badge status={r.display_status} label={def.statuses[r.display_status] ?? undefined} />
        {r.fulfil_status && <Badge status={r.fulfil_status} />}
        {r.billing_status && <Badge status={r.billing_status} />}
        {r.einvoice === 'generated' && <span className="chip bg-emerald-50 text-emerald-700">IRN</span>}
        {r.ewaybill === 'generated' && <span className="chip bg-emerald-50 text-emerald-700">EWB</span>}
      </div>
    ), csv: (r) => r.display_status },
    ...(def.dueDate ? [{ key: 'due_date', label: type === 'quote' ? 'Expiry' : 'Due Date', render: (r: any) => date(r.due_date), csv: (r: any) => r.due_date }] : []),
    ...(def.priced || type === 'retainer_invoice' ? [{ key: 'total', label: 'Amount', num: true, render: (r: any) => money(r.total, r.currency_code !== 'INR' ? `${r.currency_code} ` : '₹') }] : []),
    ...(['invoice', 'bill', 'credit_note', 'vendor_credit', 'retainer_invoice'].includes(type) ? [{ key: 'balance', label: ['credit_note', 'vendor_credit'].includes(type) ? 'Credits Remaining' : 'Balance Due', num: true, render: (r: any) => money(r.balance, r.currency_code !== 'INR' ? `${r.currency_code} ` : '₹') }] : []),
  ];
  return (
    <div>
      <PageHeader title={def.plural} subtitle={def.description}
        actions={can(def.module, 'create') && !['package', 'purchase_receive', 'sales_return'].includes(type) ? <Link to={`/docs/${type}/new`} className="btn btn-primary no-underline"><Plus className="h-4 w-4" />New</Link> : null} />
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {statusTabs.map((t) => (
              <button key={t.k} className={`chip cursor-pointer px-3 py-1 ${status === t.k ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}`} onClick={() => setSp(t.k ? { status: t.k } : {})}>{t.l}</button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Input className="w-56" placeholder="Search number, reference, contact" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search list" />
            <Input type="date" className="w-36" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
            <Input type="date" className="w-36" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
          </div>
        </div>
        {['package', 'purchase_receive', 'sales_return'].includes(type) && (
          <div className="rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-600">
            {def.plural} are created from {type === 'purchase_receive' ? 'a purchase order' : type === 'package' ? 'a sales order' : 'a sales order or invoice'} using its “Create” menu.
          </div>
        )}
        <ErrorBox error={error} />
        {loading && !data ? <Spinner /> : (
          <DataTable cols={cols} rows={data?.rows ?? []} onRow={(r) => nav(`/docs/${type}/${r.id}`)} exportName={def.plural.toLowerCase().replace(/\s+/g, '_')}
            footer={data && data.total > PAGE ? <tr><td colSpan={cols.length} className="text-center text-xs text-slate-600">
              <span className="mr-3">{page * PAGE + 1}–{page * PAGE + data.rows.length} of {data.total}</span>
              <button className="btn btn-sm mr-1" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
              <button className="btn btn-sm" disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage(page + 1)}>Next</button>
            </td></tr> : undefined} />
        )}
      </div>
    </div>
  );
}
