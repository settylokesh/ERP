import { ArrowLeft, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, del, get, post, put } from '../api';
import { DataTable } from '../components/DataTable';
import { AccountPicker, Combo, useContacts } from '../components/pickers';
import { Badge, Check, Confirm, ErrorBox, Field, Input, KeyVal, Modal, PageHeader, Select, Spinner, Stat, Tabs, Textarea, useAction } from '../components/ui';
import { date, money, qty, titleCase } from '../lib/format';
import { useApi, useCan, useDebounced, useMeta } from '../lib/hooks';
import { CustomFieldInputs } from './docs/DocForm';

function ImportModal({ path, onClose, onDone, sample }: { path: string; onClose: () => void; onDone: () => void; sample: string }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<any>(null);
  const { run, busy } = useAction();
  return (
    <Modal wide title="Import from CSV" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" disabled={busy || !csv} onClick={async () => { const r = await run(() => api(path, { method: 'POST', text: csv })); if (r) { setResult(r); onDone(); } }}>Import</button></>}>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">First row must be the header. Example:</p>
        <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-[11px]">{sample}</pre>
        <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} aria-label="CSV file" />
        <Textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="…or paste CSV here" />
        {result && <div className="rounded bg-slate-50 p-2 text-xs">Imported {result.imported}. {result.errors.length > 0 && <ul className="mt-1 list-disc pl-4 text-red-600">{result.errors.map((e: string) => <li key={e}>{e}</li>)}</ul>}</div>}
      </div>
    </Modal>
  );
}
export { ImportModal };

function ItemList() {
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const q = useDebounced(search);
  const { data, loading, error, reload } = useApi<any[]>(`/items?search=${encodeURIComponent(q)}&type=${type}&active=all`);
  const nav = useNavigate();
  const can = useCan();
  const [imp, setImp] = useState(false);
  return (
    <div>
      <PageHeader title="Items" subtitle="Goods and services you buy, make and sell"
        actions={can('items', 'create') && <><button className="btn" onClick={() => setImp(true)}><Upload className="h-4 w-4" />Import</button><Link to="/items/new" className="btn btn-primary no-underline"><Plus className="h-4 w-4" />New Item</Link></>} />
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap gap-2">
          <Input className="w-64" placeholder="Search name, SKU, HSN" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search items" />
          <Select aria-label="Item type" className="w-40" value={type} onChange={(e) => setType(e.target.value)} placeholder="All types" options={[{ value: 'goods', label: 'Goods' }, { value: 'service', label: 'Services' }]} />
        </div>
        <ErrorBox error={error} />
        {loading && !data ? <Spinner /> : (
          <DataTable exportName="items" rows={data ?? []} onRow={(r) => nav(`/items/${r.id}`)} cols={[
            { key: 'name', label: 'Name', render: (r) => <span className="link font-medium">{r.name}{!r.is_active && <span className="ml-1 text-xs text-slate-500">(inactive)</span>}</span> },
            { key: 'sku', label: 'SKU' }, { key: 'hsn_code', label: 'HSN/SAC' }, { key: 'type', label: 'Type', render: (r) => titleCase(r.type) },
            { key: 'tax_name', label: 'GST', render: (r) => (r.tax_preference !== 'taxable' ? titleCase(r.tax_preference) : r.tax_rate != null ? `${r.tax_rate}%` : '-') },
            { key: 'stock_on_hand', label: 'Stock on Hand', num: true, render: (r) => (r.track_inventory ? <span className={r.reorder_level && r.stock_on_hand <= r.reorder_level ? 'font-medium text-amber-700' : ''}>{qty(r.stock_on_hand)} {r.unit}</span> : '-') },
            { key: 'sales_rate', label: 'Selling Price', num: true, render: (r) => money(r.sales_rate) },
            { key: 'purchase_rate', label: 'Cost Price', num: true, render: (r) => money(r.purchase_rate) },
          ]} />
        )}
      </div>
      {imp && <ImportModal path="/items/import" onClose={() => setImp(false)} onDone={reload} sample={'name,sku,unit,hsn_code,gst_rate,sales_rate,purchase_rate,type\nSteel Rod 10mm,RM-ROD-10,kg,7214,18,95,70,goods'} />}
    </div>
  );
}

function ItemForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const { meta } = useMeta();
  const { contacts: vendors } = useContacts('vendor');
  const { run, busy } = useAction();
  const [f, setF] = useState<any>(id ? null : { type: 'goods', unit: 'pcs', tax_preference: 'taxable', track_inventory: true, tracking: 'none', opening_stock: [], custom: {}, tax_id: meta.taxes.find((t) => t.rate === 18 && t.is_active)?.id });
  useEffect(() => { if (id) get(`/items/${id}`).then((i) => setF({ ...i, track_inventory: !!i.track_inventory })); }, [id]);
  if (!f) return <Spinner />;
  const set = (p: any) => setF({ ...f, ...p });
  const save = async () => {
    const r = await run(() => (id ? put(`/items/${id}`, f) : post('/items', f)), 'Item saved');
    if (r) nav(`/items/${r.id}`);
  };
  return (
    <div className="pb-20">
      <PageHeader title={id ? `Edit ${f.name}` : 'New Item'} back={<Link to="/items" className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />Items</Link>} />
      <div className="space-y-5 p-5">
        <div className="card grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Type"><Select value={f.type} onChange={(e) => set({ type: e.target.value, track_inventory: e.target.value === 'goods' })} options={[{ value: 'goods', label: 'Goods' }, { value: 'service', label: 'Service' }]} /></Field>
          <Field label="Name" required><Input value={f.name ?? ''} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="SKU"><Input value={f.sku ?? ''} onChange={(e) => set({ sku: e.target.value })} /></Field>
          <Field label="Unit"><Input list="units" value={f.unit ?? ''} onChange={(e) => set({ unit: e.target.value })} /><datalist id="units">{['pcs', 'nos', 'kg', 'g', 'ltr', 'mtr', 'box', 'set', 'pair', 'dozen', 'job', 'hour'].map((u) => <option key={u} value={u} />)}</datalist></Field>
          <Field label={f.type === 'service' ? 'SAC' : 'HSN Code'}><Input value={f.hsn_code ?? ''} onChange={(e) => set({ hsn_code: e.target.value })} /></Field>
          <Field label="Tax Preference"><Select value={f.tax_preference} onChange={(e) => set({ tax_preference: e.target.value })} options={[{ value: 'taxable', label: 'Taxable' }, { value: 'exempt', label: 'Exempt' }, { value: 'nil', label: 'Nil rated' }, { value: 'non_gst', label: 'Non-GST supply' }]} /></Field>
          {f.tax_preference === 'taxable' && <Field label="GST Rate"><Select value={f.tax_id ?? ''} onChange={(e) => set({ tax_id: Number(e.target.value) || null })} options={meta.taxes.filter((t) => t.is_active).map((t) => ({ value: t.id, label: t.name }))} /></Field>}
          <Field label="Description" className="sm:col-span-2"><Input value={f.description ?? ''} onChange={(e) => set({ description: e.target.value })} /></Field>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="card space-y-3 p-5"><h3>Sales Information</h3>
            <Field label="Selling Price (₹)"><Input type="number" value={f.sales_rate ?? ''} onChange={(e) => set({ sales_rate: e.target.value })} /></Field>
            <Field label="Sales Account"><AccountPicker value={f.sales_account_id} onChange={(v) => set({ sales_account_id: v })} categories={['income']} /></Field>
          </div>
          <div className="card space-y-3 p-5"><h3>Purchase Information</h3>
            <Field label="Cost Price (₹)"><Input type="number" value={f.purchase_rate ?? ''} onChange={(e) => set({ purchase_rate: e.target.value })} /></Field>
            <Field label={f.track_inventory ? 'Cost of Goods Sold Account' : 'Purchase Account'}><AccountPicker value={f.purchase_account_id} onChange={(v) => set({ purchase_account_id: v })} categories={['expense']} /></Field>
            <Field label="Preferred Vendor"><Combo options={vendors.map((v) => ({ value: v.id, label: v.name }))} value={f.preferred_vendor_id} onChange={(v) => set({ preferred_vendor_id: v })} /></Field>
          </div>
        </div>
        {f.type === 'goods' && (
          <div className="card space-y-4 p-5">
            <Check label="Track inventory for this item" checked={!!f.track_inventory} onChange={(v) => set({ track_inventory: v })} />
            {f.track_inventory && (
              <>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Inventory Account"><AccountPicker value={f.inventory_account_id} onChange={(v) => set({ inventory_account_id: v })} types={['stock']} /></Field>
                  <Field label="Reorder Level"><Input type="number" value={f.reorder_level ?? 0} onChange={(e) => set({ reorder_level: e.target.value })} /></Field>
                  <Field label="Advanced Tracking"><Select value={f.tracking} onChange={(e) => set({ tracking: e.target.value })} options={[{ value: 'none', label: 'None' }, { value: 'batch', label: 'Batch tracking' }, { value: 'serial', label: 'Serial number tracking' }]} /></Field>
                </div>
                <div>
                  <h3 className="mb-2">Opening Stock <span className="text-xs font-normal text-slate-500">as of {date(meta.org.inventory_start_date)}</span></h3>
                  <table className="table"><thead><tr><th>Warehouse</th><th className="num">Quantity</th><th className="num">Rate per unit</th>{f.tracking !== 'none' && <th>{f.tracking === 'serial' ? 'Serial numbers (comma separated)' : 'Batch # / Expiry'}</th>}<th /></tr></thead>
                    <tbody>{f.opening_stock.map((o: any, i: number) => {
                      const upd = (p: any) => set({ opening_stock: f.opening_stock.map((x: any, j: number) => (j === i ? { ...x, ...p } : x)) });
                      return (
                        <tr key={i}>
                          <td><Select aria-label="Warehouse" value={o.warehouse_id} onChange={(e) => upd({ warehouse_id: Number(e.target.value) })} options={meta.warehouses.map((w) => ({ value: w.id, label: w.name }))} /></td>
                          <td><Input type="number" className="text-right" value={o.qty} onChange={(e) => upd({ qty: Number(e.target.value) })} /></td>
                          <td><Input type="number" className="text-right" value={o.rate} onChange={(e) => upd({ rate: Number(e.target.value) })} /></td>
                          {f.tracking === 'serial' && <td><Input value={(o.tracking ?? []).map((t: any) => t.serial_no).join(', ')} onChange={(e) => upd({ tracking: e.target.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ serial_no: s })) })} /></td>}
                          {f.tracking === 'batch' && <td className="flex gap-1"><Input placeholder="Batch #" value={o.tracking?.[0]?.batch_no ?? ''} onChange={(e) => upd({ tracking: [{ batch_no: e.target.value, qty: o.qty, expiry_date: o.tracking?.[0]?.expiry_date ?? null }] })} /><Input type="date" value={o.tracking?.[0]?.expiry_date ?? ''} onChange={(e) => upd({ tracking: [{ batch_no: o.tracking?.[0]?.batch_no ?? '', qty: o.qty, expiry_date: e.target.value }] })} /></td>}
                          <td><button className="btn btn-ghost btn-sm" onClick={() => set({ opening_stock: f.opening_stock.filter((_: any, j: number) => j !== i) })} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button></td>
                        </tr>
                      );
                    })}</tbody></table>
                  <button className="btn btn-sm mt-2" onClick={() => set({ opening_stock: [...f.opening_stock, { warehouse_id: meta.warehouses[0]?.id, qty: 0, rate: f.purchase_rate ?? 0 }] })}><Plus className="h-3.5 w-3.5" />Add opening stock</button>
                </div>
              </>
            )}
          </div>
        )}
        <div className="card p-5"><CustomFieldInputs module="item" value={f.custom ?? {}} onChange={(v) => set({ custom: v })} /><Check label="Active" checked={f.is_active !== 0 && f.is_active !== false} onChange={(v) => set({ is_active: v })} /></div>
      </div>
      <div className="no-print fixed bottom-0 left-0 right-0 flex gap-2 border-t bg-white px-5 py-3 lg:left-60"><button className="btn btn-primary" disabled={busy} onClick={save}>Save</button><button className="btn" onClick={() => nav(-1)}>Cancel</button></div>
    </div>
  );
}

function ItemView() {
  const { id } = useParams();
  const { data: i, error, loading } = useApi<any>(`/items/${id}`);
  const nav = useNavigate();
  const can = useCan();
  const [tab, setTab] = useState('overview');
  const [del_, setDel] = useState(false);
  const { run } = useAction();
  if (loading && !i) return <Spinner />;
  if (error || !i) return <div className="p-6"><ErrorBox error={error} /></div>;
  return (
    <div>
      <PageHeader title={i.name} subtitle={[i.sku, titleCase(i.type), i.hsn_code && `HSN ${i.hsn_code}`].filter(Boolean).join(' · ')}
        back={<Link to="/items" className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />Items</Link>}
        actions={<>{can('items', 'edit') && <Link to={`/items/${id}/edit`} className="btn no-underline">Edit</Link>}{can('items', 'delete') && <button className="btn" onClick={() => setDel(true)}>Delete</button>}</>} />
      <div className="px-5 pt-3"><Tabs active={tab} onChange={setTab} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'transactions', label: 'Stock Transactions' }, ...(i.tracking !== 'none' ? [{ key: 'tracking', label: i.tracking === 'serial' ? 'Serial Numbers' : 'Batches' }] : [])]} /></div>
      <div className="space-y-4 p-5">
        {tab === 'overview' && (
          <>
            {i.stock && (
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="Physical stock" value={`${qty(i.stock.physical)} ${i.unit}`} />
                <Stat label="Accounting stock" value={qty(i.stock.accounting)} />
                <Stat label="Committed" value={qty(i.stock.committed)} />
                <Stat label="Available for sale" value={qty(i.stock.available)} tone={i.stock.available <= i.reorder_level ? 'warn' : undefined} />
                <Stat label="To be received" value={qty(i.stock.incoming)} />
                <Stat label="Stock value" value={money(i.stock.value)} sub={`Avg cost ${money(i.stock.avg_cost)}`} />
              </div>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="card p-4"><h3 className="mb-2">Details</h3><KeyVal items={[['Selling price', money(i.sales_rate)], ['Cost price', money(i.purchase_rate)], ['GST', i.tax_preference === 'taxable' ? i.tax_name : titleCase(i.tax_preference)], ['Unit', i.unit], ['Tracking', titleCase(i.tracking)], ['Reorder level', i.reorder_level], ['Description', i.description], ['Status', i.is_active ? 'Active' : 'Inactive']]} /></div>
              {i.stock && <div className="card p-4"><h3 className="mb-2">Stock by warehouse</h3><table className="table"><thead><tr><th>Warehouse</th><th className="num">Physical</th><th className="num">Accounting</th><th className="num">Committed</th></tr></thead><tbody>{i.stock.warehouses.map((w: any) => <tr key={w.warehouse_id}><td>{w.name}</td><td className="num">{qty(w.physical)}</td><td className="num">{qty(w.accounting)}</td><td className="num">{qty(w.committed)}</td></tr>)}</tbody></table></div>}
              {i.boms.length > 0 && <div className="card p-4"><h3 className="mb-2">Bills of materials</h3>{i.boms.map((b: any) => <div key={b.id}><Link to={`/manufacturing/boms/${b.id}`}>{b.number} · {b.name}</Link></div>)}</div>}
              {i.price_lists.length > 0 && <div className="card p-4"><h3 className="mb-2">Price lists</h3>{i.price_lists.map((p: any) => <div key={p.id} className="flex justify-between"><span>{p.name}</span><span>{money(p.rate)}</span></div>)}</div>}
            </div>
          </>
        )}
        {tab === 'transactions' && (
          <DataTable rows={i.transactions} onRow={(r) => (r.source_type === 'mo' ? nav(`/manufacturing/orders/${r.source_id}`) : r.source_type !== 'item_opening' && nav(`/docs/${r.source_type}/${r.source_id}`))} cols={[
            { key: 'date', label: 'Date', render: (r) => date(r.date) }, { key: 'reference', label: 'Reference', render: (r) => <span className="link">{r.reference}</span> },
            { key: 'kind', label: 'Type', render: (r) => titleCase(r.kind) }, { key: 'warehouse_name', label: 'Warehouse' },
            { key: 'batch_no', label: 'Batch/Serial', render: (r) => r.batch_no ?? r.serial_no ?? '' },
            { key: 'qty', label: 'Qty', num: true, render: (r) => <span className={r.qty < 0 ? 'text-red-600' : 'text-emerald-700'}>{qty(r.qty)}</span> },
            { key: 'value', label: 'Value', num: true, render: (r) => (r.accounting ? money(r.value) : '-') },
            { key: 'flags', label: 'Stock', render: (r) => [r.physical && 'Physical', r.accounting && 'Accounting'].filter(Boolean).join(' + ') },
          ]} />
        )}
        {tab === 'tracking' && (
          <DataTable rows={i.tracking === 'serial' ? i.serials : i.batches} cols={i.tracking === 'serial'
            ? [{ key: 'serial_no', label: 'Serial #' }, { key: 'warehouse_id', label: 'Warehouse', render: (r) => r.warehouse_id }]
            : [{ key: 'batch_no', label: 'Batch #' }, { key: 'expiry_date', label: 'Expiry', render: (r) => date(r.expiry_date) }, { key: 'qty', label: 'Quantity', num: true, render: (r) => qty(r.qty) }]} />
        )}
      </div>
      {del_ && <Confirm danger title="Delete item" message={`Delete ${i.name}?`} confirmLabel="Delete" onClose={() => setDel(false)} onConfirm={async () => { setDel(false); if (await run(() => del(`/items/${id}`), 'Item deleted')) nav('/items'); }} />}
    </div>
  );
}

function PriceLists() {
  const { data, reload } = useApi<any[]>('/price-lists');
  const { data: items } = useApi<any[]>('/items');
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  const can = useCan();
  return (
    <div>
      <PageHeader title="Price Lists" subtitle="Customer- or vendor-specific pricing by percentage or per item" actions={can('items', 'create') && <button className="btn btn-primary" onClick={() => setEdit({ kind: 'sales', mode: 'percentage', percentage: 0, items: [] })}><Plus className="h-4 w-4" />New Price List</button>} />
      <div className="p-5">
        <DataTable rows={data ?? []} onRow={(r) => setEdit({ ...r, items: r.items.map((x: any) => ({ item_id: x.item_id, rate: x.rate })) })} cols={[
          { key: 'name', label: 'Name', render: (r) => <span className="link">{r.name}</span> }, { key: 'kind', label: 'Type', render: (r) => titleCase(r.kind) },
          { key: 'mode', label: 'Pricing', render: (r) => (r.mode === 'percentage' ? `${r.percentage > 0 ? 'Markup' : 'Markdown'} ${Math.abs(r.percentage)}%` : `${r.items.length} item rates`) },
          { key: 'is_active', label: 'Status', render: (r) => <Badge status={r.is_active ? 'active' : 'inactive'} /> },
        ]} />
      </div>
      {edit && (
        <Modal wide title={edit.id ? 'Edit price list' : 'New price list'} onClose={() => setEdit(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => (edit.id ? put(`/price-lists/${edit.id}`, edit) : post('/price-lists', edit)), 'Saved')) { setEdit(null); reload(); } }}>Save</button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Type"><Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })} options={[{ value: 'sales', label: 'Sales' }, { value: 'purchase', label: 'Purchase' }]} /></Field>
            <Field label="Pricing scheme"><Select value={edit.mode} onChange={(e) => setEdit({ ...edit, mode: e.target.value })} options={[{ value: 'percentage', label: 'Markup / markdown by %' }, { value: 'per_item', label: 'Individual item rates' }]} /></Field>
            {edit.mode === 'percentage' && <Field label="Percentage (negative = markdown)"><Input type="number" value={edit.percentage} onChange={(e) => setEdit({ ...edit, percentage: Number(e.target.value) })} /></Field>}
          </div>
          {edit.mode === 'per_item' && (
            <table className="table mt-3"><thead><tr><th>Item</th><th className="num">Base rate</th><th className="num">Price list rate</th></tr></thead>
              <tbody>{(items ?? []).filter((x) => x.is_active).map((it) => {
                const cur = edit.items.find((x: any) => x.item_id === it.id);
                return <tr key={it.id}><td>{it.name}</td><td className="num">{money(edit.kind === 'sales' ? it.sales_rate : it.purchase_rate)}</td>
                  <td><Input type="number" className="text-right" value={cur?.rate ?? ''} onChange={(e) => setEdit({ ...edit, items: [...edit.items.filter((x: any) => x.item_id !== it.id), ...(e.target.value === '' ? [] : [{ item_id: it.id, rate: Number(e.target.value) }])] })} /></td></tr>;
              })}</tbody></table>
          )}
        </Modal>
      )}
    </div>
  );
}

export default function Items({ priceLists }: { priceLists?: boolean }) {
  if (priceLists) return <PriceLists />;
  return (
    <Routes>
      <Route index element={<ItemList />} />
      <Route path="new" element={<ItemForm />} />
      <Route path=":id" element={<ItemView />} />
      <Route path=":id/edit" element={<ItemForm />} />
    </Routes>
  );
}
