import { ArrowLeft, Plus, Upload } from 'lucide-react';
import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, del, get, post } from '../api';
import { DataTable } from '../components/DataTable';
import { AccountPicker, ContactPicker } from '../components/pickers';
import { Badge, Field, Input, Modal, PageHeader, Select, Spinner, Stat, Tabs, Textarea, useAction } from '../components/ui';
import { date, money, titleCase, today } from '../lib/format';
import { useApi, useCan, useMeta } from '../lib/hooks';
import { sourceLink } from './Accountant';

function TxnModal({ accountId, onClose, onDone }: { accountId?: number; onClose: () => void; onDone: () => void }) {
  const { meta } = useMeta();
  const [f, setF] = useState<any>({ kind: 'expense', date: today(), account_id: accountId });
  const { run, busy } = useAction();
  return (
    <Modal title="Add bank transaction" onClose={onClose} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => post('/banking/transactions', f), 'Transaction saved')) onDone(); }}>Save</button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type" className="sm:col-span-2"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={Object.entries(meta.bank_txn_kinds).map(([k, v]) => ({ value: k, label: `${v.label} (${v.direction === 'in' ? 'money in' : 'money out'})` }))} /></Field>
        <Field label="Bank / cash account"><AccountPicker value={f.account_id} onChange={(v) => setF({ ...f, account_id: v })} types={['bank', 'cash', 'credit_card']} /></Field>
        <Field label={f.kind.startsWith('transfer') ? 'Other account' : 'Category account'}><AccountPicker value={f.offset_account_id} onChange={(v) => setF({ ...f, offset_account_id: v })} /></Field>
        <Field label="Amount"><Input type="number" value={f.amount ?? ''} onChange={(e) => setF({ ...f, amount: Number(e.target.value) })} /></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Reference"><Input value={f.reference ?? ''} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label="Description"><Input value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function Overview() {
  const { data, loading, reload } = useApi<any[]>('/banking/accounts');
  const nav = useNavigate();
  const can = useCan();
  const [txn, setTxn] = useState(false);
  return (
    <div>
      <PageHeader title="Banking" subtitle="Bank, cash and card accounts, statement feeds and reconciliation"
        actions={<>{can('banking', 'create') && <button className="btn" onClick={() => setTxn(true)}><Plus className="h-4 w-4" />Add Transaction</button>}{can('accountant', 'create') && <Link to="/accountant/accounts" className="btn btn-primary no-underline">Add Bank Account</Link>}</>} />
      <div className="p-5">
        {loading && !data ? <Spinner /> : (
          <DataTable rows={data ?? []} onRow={(r) => nav(`/banking/${r.id}`)} cols={[
            { key: 'name', label: 'Account', render: (r) => <span className="link font-medium">{r.name}<div className="text-[11px] font-normal text-slate-500">{[r.bank_name, r.account_number && `••${String(r.account_number).slice(-4)}`].filter(Boolean).join(' ')}</div></span> },
            { key: 'type', label: 'Type', render: (r) => titleCase(r.type) },
            { key: 'uncategorized', label: 'Uncategorised', num: true, render: (r) => (r.uncategorized ? <span className="font-medium text-amber-700">{r.uncategorized}</span> : '0') },
            { key: 'last_reconciled', label: 'Reconciled up to', render: (r) => date(r.last_reconciled) },
            { key: 'statement_balance', label: 'Statement Balance', num: true, render: (r) => money(r.statement_balance) },
            { key: 'balance', label: 'Balance in Books', num: true, render: (r) => money(r.balance) },
          ]} />
        )}
      </div>
      {txn && <TxnModal onClose={() => setTxn(false)} onDone={() => { setTxn(false); reload(); }} />}
    </div>
  );
}

function CategorizeModal({ line, onClose, onDone }: { line: any; onClose: () => void; onDone: () => void }) {
  const isIn = line.deposit > 0;
  const { meta } = useMeta();
  const { data: matches } = useApi<any[]>(`/banking/lines/${line.id}/matches`);
  const [mode, setMode] = useState<'match' | 'create'>('match');
  const [f, setF] = useState<any>({ kind: isIn ? 'customer_payment' : 'expense' });
  const [docs, setDocs] = useState<any[]>([]);
  const [alloc, setAlloc] = useState<Record<number, string>>({});
  const { run, busy } = useAction();
  const kinds = [
    ...(isIn ? [{ value: 'customer_payment', label: 'Customer payment' }] : [{ value: 'vendor_payment', label: 'Vendor payment' }]),
    ...Object.entries(meta.bank_txn_kinds).filter(([, v]) => (v.direction === 'in') === isIn).map(([k, v]) => ({ value: k, label: v.label })),
  ];
  const isPayment = f.kind === 'customer_payment' || f.kind === 'vendor_payment';
  return (
    <Modal wide title={`${isIn ? 'Deposit' : 'Withdrawal'} of ${money(line.deposit || line.withdrawal)} on ${date(line.date)}`} onClose={onClose}>
      <div className="mb-3 text-xs text-slate-500">{line.description} {line.reference && `· ${line.reference}`}</div>
      <Tabs active={mode} onChange={(k) => setMode(k as any)} tabs={[{ key: 'match', label: `Match (${matches?.length ?? 0})` }, { key: 'create', label: 'Categorise' }]} />
      <div className="pt-3">
        {mode === 'match' ? (
          !matches?.length ? <div className="text-slate-500">No transactions in the books match this amount within 7 days. Categorise it instead.</div> : (
            <table className="table"><tbody>{matches.map((m) => (
              <tr key={`${m.source_type}${m.source_id}`}><td>{date(m.date)}</td><td>{m.memo}</td><td>{m.reference}</td><td className="num">{money(m.amount)}</td>
                <td><button className="btn btn-sm btn-primary" disabled={busy} onClick={async () => { if (await run(() => post(`/banking/lines/${line.id}/match`, { source_type: m.source_type, source_id: m.source_id }), 'Matched')) onDone(); }}>Match</button></td></tr>
            ))}</tbody></table>
          )
        ) : (
          <div className="space-y-3">
            <Field label="Category"><Select value={f.kind} onChange={(e) => setF({ kind: e.target.value })} options={kinds} /></Field>
            {isPayment ? (
              <>
                <Field label={isIn ? 'Customer' : 'Vendor'}><ContactPicker kind={isIn ? 'customer' : 'vendor'} value={f.contact_id} onChange={async (v) => { setF({ ...f, contact_id: v }); setAlloc({}); setDocs(v ? await get(`/contacts/${v}/open-documents?kind=${isIn ? 'received' : 'made'}`) : []); }} /></Field>
                {docs.length > 0 && <table className="table"><tbody>{docs.map((d) => <tr key={d.id}><td>{d.number}</td><td className="num">{money(d.balance)}</td><td><Input type="number" className="text-right" value={alloc[d.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [d.id]: e.target.value })} /></td></tr>)}</tbody></table>}
              </>
            ) : (
              <Field label={f.kind.startsWith('transfer') ? 'Other bank/cash account' : 'Account'}><AccountPicker value={f.offset_account_id} onChange={(v) => setF({ ...f, offset_account_id: v })} /></Field>
            )}
            <Field label="Description"><Textarea rows={2} value={f.description ?? line.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
            <button className="btn btn-primary" disabled={busy} onClick={async () => {
              const body = { ...f, allocations: Object.entries(alloc).map(([document_id, amount]) => ({ document_id: Number(document_id), amount: Number(amount) })).filter((a) => a.amount > 0) };
              if (await run(() => post(`/banking/lines/${line.id}/categorize`, body), 'Categorised')) onDone();
            }}>Save</button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Reconcile({ account, onDone }: { account: any; onDone: () => void }) {
  const [end, setEnd] = useState(today());
  const [closing, setClosing] = useState('');
  const { data, reload } = useApi<any>(`/banking/reconcile?account_id=${account.id}&end_date=${end}`);
  const { data: history, reload: reloadHistory } = useApi<any[]>(`/banking/reconciliations?account_id=${account.id}`);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const { run, busy } = useAction();
  if (!data) return <Spinner />;
  const cleared = data.opening + data.lines.filter((l: any) => checked.has(l.id)).reduce((a: number, l: any) => a + l.amount, 0);
  const diff = (Number(closing) || 0) - cleared;
  return (
    <div className="space-y-4">
      <div className="card grid gap-3 p-4 sm:grid-cols-4">
        <Field label="Statement end date"><Input type="date" value={end} onChange={(e) => { setEnd(e.target.value); setChecked(new Set()); }} /></Field>
        <Field label="Closing balance as per statement"><Input type="number" value={closing} onChange={(e) => setClosing(e.target.value)} /></Field>
        <Stat label="Cleared balance" value={money(cleared)} sub={`Opening ${money(data.opening)}`} />
        <Stat label="Difference" value={money(diff)} tone={Math.abs(diff) < 0.005 ? 'good' : 'bad'} />
      </div>
      <div className="card overflow-x-auto p-4">
        <div className="mb-2 flex items-center justify-between"><h3>Unreconciled transactions up to {date(end)}</h3>
          <button className="btn btn-sm" onClick={() => setChecked(checked.size === data.lines.length ? new Set() : new Set(data.lines.map((l: any) => l.id)))}>Toggle all</button></div>
        <table className="table"><thead><tr><th /><th>Date</th><th>Transaction</th><th>Contact</th><th className="num">Deposit</th><th className="num">Withdrawal</th></tr></thead>
          <tbody>{data.lines.map((l: any) => (
            <tr key={l.id} className="cursor-pointer" onClick={() => { const n = new Set(checked); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); setChecked(n); }}>
              <td><input type="checkbox" readOnly checked={checked.has(l.id)} aria-label="Cleared" /></td><td>{date(l.date)}</td><td>{l.memo}</td><td>{l.contact_name}</td>
              <td className="num">{l.amount > 0 ? money(l.amount) : ''}</td><td className="num">{l.amount < 0 ? money(-l.amount) : ''}</td></tr>
          ))}</tbody></table>
        <button className="btn btn-primary mt-3" disabled={busy || Math.abs(diff) > 0.004 || closing === ''} onClick={async () => {
          if (await run(() => post('/banking/reconcile', { account_id: account.id, end_date: end, closing_balance: Number(closing), cleared_line_ids: [...checked] }), 'Reconciled')) { setChecked(new Set()); reload(); reloadHistory(); onDone(); }
        }}>Complete reconciliation</button>
      </div>
      {history && history.length > 0 && (
        <div className="card p-4"><h3 className="mb-2">Reconciliation history</h3>
          <table className="table"><tbody>{history.map((h) => <tr key={h.id}><td>Up to {date(h.end_date)}</td><td className="num">{money(h.closing_balance)}</td><td>{date(h.completed_at)}</td>
            <td><button className="text-xs text-red-600" onClick={async () => { if (await run(() => del(`/banking/reconciliations/${h.id}`), 'Reconciliation undone')) { reload(); reloadHistory(); onDone(); } }}>Undo</button></td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}

function AccountDetail() {
  const { id } = useParams();
  const { data: accounts, reload: reloadAccounts } = useApi<any[]>('/banking/accounts');
  const account = accounts?.find((a) => a.id === Number(id));
  const [tab, setTab] = useState('statement');
  const [status, setStatus] = useState('uncategorized');
  const { data: lines, reload } = useApi<any[]>(`/banking/accounts/${id}/statement?status=${status}`);
  const { data: txns, reload: reloadTxns } = useApi<any>(tab === 'books' ? `/accounts/${id}/transactions` : null);
  const [imp, setImp] = useState(false);
  const [csv, setCsv] = useState('');
  const [cat, setCat] = useState<any>(null);
  const [txn, setTxn] = useState(false);
  const { run, busy } = useAction();
  const nav = useNavigate();
  const refresh = () => { reload(); reloadAccounts(); reloadTxns(); };
  if (!account) return <Spinner />;
  return (
    <div>
      <PageHeader title={account.name} subtitle={`Balance in books ${money(account.balance)} · statement ${money(account.statement_balance)}`}
        back={<Link to="/banking" className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />Banking</Link>}
        actions={<><button className="btn" onClick={() => setTxn(true)}><Plus className="h-4 w-4" />Add Transaction</button><button className="btn btn-primary" onClick={() => setImp(true)}><Upload className="h-4 w-4" />Import Statement</button></>} />
      <div className="px-5 pt-3"><Tabs active={tab} onChange={setTab} tabs={[{ key: 'statement', label: `Bank Statement (${account.uncategorized} to review)` }, { key: 'books', label: 'Transactions in Books' }, { key: 'reconcile', label: 'Reconcile' }]} /></div>
      <div className="space-y-3 p-5">
        {tab === 'statement' && (
          <>
            <div className="flex gap-1">{['uncategorized', 'matched', 'categorized', 'excluded', ''].map((s) => <button key={s} className={`chip cursor-pointer px-3 py-1 ${status === s ? 'bg-brand-600 text-white' : 'bg-white ring-1 ring-slate-200'}`} onClick={() => setStatus(s)}>{s ? titleCase(s) : 'All'}</button>)}</div>
            <DataTable rows={lines ?? []} cols={[
              { key: 'date', label: 'Date', render: (r) => date(r.date) }, { key: 'description', label: 'Description' }, { key: 'reference', label: 'Reference' },
              { key: 'deposit', label: 'Deposits', num: true, render: (r) => (r.deposit ? money(r.deposit) : '') }, { key: 'withdrawal', label: 'Withdrawals', num: true, render: (r) => (r.withdrawal ? money(r.withdrawal) : '') },
              { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
              { key: 'act', label: '', render: (r) => r.status === 'uncategorized' ? (
                <span className="flex gap-2"><button className="text-xs text-brand-600" onClick={() => setCat(r)}>Match / Categorise</button><button className="text-xs text-slate-500" onClick={async () => { if (await run(() => post(`/banking/lines/${r.id}/status`, { status: 'excluded' }))) refresh(); }}>Exclude</button></span>
              ) : r.status === 'excluded' || r.status === 'matched' ? <button className="text-xs text-slate-500" onClick={async () => { if (await run(() => post(`/banking/lines/${r.id}/status`, { status: 'uncategorized' }))) refresh(); }}>Undo</button> : null },
            ]} empty={<div className="p-8 text-center text-slate-500">No statement lines. Import a CSV from your bank.</div>} />
          </>
        )}
        {tab === 'books' && txns && (
          <DataTable exportName="bank_transactions" rows={[...txns.rows].reverse()} onRow={(r) => { const l = sourceLink(r); if (l) nav(l); }} cols={[
            { key: 'date', label: 'Date', render: (r) => date(r.date) }, { key: 'memo', label: 'Transaction' }, { key: 'contact_name', label: 'Contact' },
            { key: 'debit', label: 'Deposit', num: true, render: (r) => (r.debit ? money(r.debit) : '') }, { key: 'credit', label: 'Withdrawal', num: true, render: (r) => (r.credit ? money(r.credit) : '') },
            { key: 'balance', label: 'Running Balance', num: true, render: (r) => money(r.balance) },
            { key: 'recon_id', label: '', render: (r) => (r.recon_id ? <span className="chip bg-emerald-50 text-emerald-700">Reconciled</span> : '') },
          ]} />
        )}
        {tab === 'reconcile' && <Reconcile account={account} onDone={refresh} />}
      </div>
      {imp && (
        <Modal title="Import bank statement (CSV)" onClose={() => setImp(false)} footer={<button className="btn btn-primary" disabled={busy || !csv} onClick={async () => { const r = await run(() => api(`/banking/accounts/${id}/import`, { method: 'POST', text: csv })); if (r) { setImp(false); setCsv(''); refresh(); } }}>Import</button>}>
          <div className="space-y-2 text-xs text-slate-500">
            <p>Columns: <code>Date, Description, Reference, Withdrawal, Deposit</code> (or a signed <code>Amount</code>). Dates as YYYY-MM-DD or DD/MM/YYYY. Duplicate lines are skipped.</p>
            <input type="file" accept=".csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} aria-label="Statement CSV" />
            <Textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="…or paste CSV" />
          </div>
        </Modal>
      )}
      {cat && <CategorizeModal line={cat} onClose={() => setCat(null)} onDone={() => { setCat(null); refresh(); }} />}
      {txn && <TxnModal accountId={account.id} onClose={() => setTxn(false)} onDone={() => { setTxn(false); refresh(); }} />}
    </div>
  );
}

export default function Banking() {
  return (
    <Routes>
      <Route index element={<Overview />} />
      <Route path=":id" element={<AccountDetail />} />
    </Routes>
  );
}

