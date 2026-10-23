import { Plus, Trash2, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { get } from '../api';
import { money, qty as fq } from '../lib/format';
import { useMeta } from '../lib/hooks';
import { AccountPicker, ItemPicker, TaxSelect, useItems } from './pickers';
import { Check, Modal } from './ui';

export interface Line {
  id?: number;
  item_id?: number | null;
  account_id?: number | null;
  description?: string;
  hsn_code?: string;
  unit?: string;
  qty?: number | string;
  qty2?: number | string | null;
  rate?: number | string;
  discount_pct?: number | string;
  tax_id?: number | null;
  tax_exempt?: string | null;
  ref_line_id?: number | null;
  warehouse_id?: number | null;
  itc_eligible?: boolean;
  tracking?: any[];
  data?: Record<string, any>;
}

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Client-side estimate of GST (the server recomputes authoritatively on save). */
export function computeTotals(lines: Line[], opts: { kind: 'intra' | 'inter' | 'none'; inclusive: boolean; taxes: any[]; adjustment: number; reverseCharge?: boolean; tdsRate?: number }) {
  let taxable = 0, cgst = 0, sgst = 0, igst = 0, discount = 0;
  const rows = lines.map((l) => {
    const q = Number(l.qty) || 0, rate = Number(l.rate) || 0, d = Number(l.discount_pct) || 0;
    const gross = r2(q * rate);
    const disc = r2(gross * d / 100);
    const net = r2(gross - disc);
    const t = opts.taxes.find((x) => x.id === l.tax_id);
    const tr = l.tax_exempt || opts.kind === 'none' ? 0 : t?.rate ?? 0;
    const tx = opts.inclusive && tr ? r2(net * 100 / (100 + tr)) : net;
    let c = 0, s = 0, i = 0;
    if (tr) { if (opts.kind === 'intra') { c = r2(tx * tr / 200); s = c; } else i = r2(tx * tr / 100); }
    taxable += tx; cgst += c; sgst += s; igst += i; discount += disc;
    return { taxable: tx, tax: c + s + i };
  });
  const tax = r2(cgst + sgst + igst);
  const tds = opts.tdsRate ? r2(taxable * opts.tdsRate / 100) : 0;
  const total = r2(taxable + (opts.reverseCharge ? 0 : tax) + opts.adjustment - tds);
  return { rows, taxable: r2(taxable), discount: r2(discount), cgst: r2(cgst), sgst: r2(sgst), igst: r2(igst), tax, tds, total };
}

function TrackingModal({ line, item, warehouseId, outflow, onClose, onSave }: { line: Line; item: any; warehouseId: number | null; outflow: boolean; onClose: () => void; onSave: (t: any[]) => void }) {
  const [rows, setRows] = useState<any[]>(line.tracking?.length ? line.tracking : item.tracking === 'serial' ? [] : [{ batch_no: '', qty: Number(line.qty) || 0, expiry_date: '' }]);
  const [avail, setAvail] = useState<any[] | null>(null);
  const [serialText, setSerialText] = useState((line.tracking ?? []).map((t: any) => t.serial_no).join('\n'));
  const loadAvail = async () => {
    if (!warehouseId) return;
    setAvail(await get(`/items/${item.id}/${item.tracking === 'serial' ? 'serials' : 'batches'}?warehouse_id=${warehouseId}`));
  };
  const save = () => {
    if (item.tracking === 'serial') onSave(serialText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map((s) => ({ serial_no: s })));
    else onSave(rows.filter((r) => r.batch_no).map((r) => ({ batch_no: r.batch_no, qty: Number(r.qty), expiry_date: r.expiry_date || null })));
    onClose();
  };
  return (
    <Modal title={`${item.tracking === 'serial' ? 'Serial numbers' : 'Batches'} — ${item.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
      <div className="space-y-3">
        <div className="text-xs text-slate-500">Line quantity: {fq(line.qty)} {item.unit}</div>
        {outflow && <button className="btn btn-sm" onClick={loadAvail} disabled={!warehouseId}>Show available {item.tracking === 'serial' ? 'serials' : 'batches'}</button>}
        {avail && (
          <div className="flex flex-wrap gap-1">
            {avail.length === 0 && <span className="text-xs text-slate-500">None in this warehouse</span>}
            {avail.map((a: any) => typeof a === 'string'
              ? <button key={a} className="chip bg-slate-100 hover:bg-brand-100" onClick={() => setSerialText((t) => (t.split(/\n/).includes(a) ? t : `${t ? t + '\n' : ''}${a}`))}>{a}</button>
              : <button key={a.batch_no} className="chip bg-slate-100 hover:bg-brand-100" onClick={() => setRows((r) => [...r.filter((x) => x.batch_no), { batch_no: a.batch_no, qty: Math.min(a.qty, Number(line.qty) || a.qty), expiry_date: a.expiry_date ?? '' }])}>{a.batch_no} ({fq(a.qty)})</button>)}
          </div>
        )}
        {item.tracking === 'serial' ? (
          <textarea className="input font-mono" rows={6} placeholder="One serial number per line" value={serialText} onChange={(e) => setSerialText(e.target.value)} aria-label="Serial numbers" />
        ) : (
          <table className="table">
            <thead><tr><th>Batch #</th><th className="num">Quantity</th><th>Expiry</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td><input className="input" value={r.batch_no} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, batch_no: e.target.value } : x)))} aria-label="Batch number" /></td>
                  <td><input className="input text-right" type="number" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} aria-label="Batch quantity" /></td>
                  <td><input className="input" type="date" value={r.expiry_date ?? ''} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, expiry_date: e.target.value } : x)))} aria-label="Expiry date" /></td>
                  <td><button className="btn btn-ghost btn-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove batch"><Trash2 className="h-3.5 w-3.5" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {item.tracking === 'batch' && <button className="btn btn-sm" onClick={() => setRows([...rows, { batch_no: '', qty: 0, expiry_date: '' }])}><Plus className="h-3.5 w-3.5" />Add batch</button>}
      </div>
    </Modal>
  );
}

export function LineItems({ type, lines, setLines, priced, side, kind, inclusive, warehouseId, mode, priceList }: {
  type: string; lines: Line[]; setLines: (l: Line[]) => void; priced: boolean; side: 'sales' | 'purchase' | 'none';
  kind: 'intra' | 'inter' | 'none'; inclusive: boolean; warehouseId: number | null; mode?: string; priceList?: number | null;
}) {
  const { meta } = useMeta();
  const { items } = useItems();
  const [tracking, setTracking] = useState<number | null>(null);
  const update = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pickItem = async (i: number, id: number | null, it?: any) => {
    if (!id || !it) return update(i, { item_id: null });
    let rate = side === 'purchase' ? it.purchase_rate : side === 'sales' ? it.sales_rate : type === 'purchase_request' ? it.purchase_rate : 0;
    if (priceList && side !== 'none') {
      try { rate = (await get(`/items/${id}/price?price_list_id=${priceList}&side=${side}`)).rate; } catch { /* keep base rate */ }
    }
    update(i, { item_id: id, account_id: null, description: it.description ?? '', hsn_code: it.hsn_code ?? '', unit: it.unit, rate, tax_id: it.tax_preference === 'taxable' ? it.tax_id : null, tax_exempt: it.tax_preference !== 'taxable' ? it.tax_preference : null, tracking: [] });
  };
  const allowAccount = ['invoice', 'credit_note', 'bill', 'vendor_credit', 'expense', 'purchase_order'].includes(type);
  const expenseOnly = type === 'expense';
  const totals = computeTotals(lines, { kind, inclusive, taxes: meta.taxes, adjustment: 0 });
  const outflow = ['invoice', 'package', 'delivery_challan', 'vendor_credit', 'transfer_order'].includes(type) || (type === 'inventory_adjustment');
  const isCount = type === 'stock_count';
  const isValueAdj = type === 'inventory_adjustment' && mode === 'value';
  const showRate = priced || ['purchase_request', 'retainer_invoice', 'sales_return', 'inventory_adjustment'].includes(type) && !isValueAdj;
  return (
    <div className="overflow-x-auto">
      <table className="table min-w-[860px]">
        <thead>
          <tr>
            <th className="w-8">#</th>
            <th className="min-w-[260px]">{expenseOnly ? 'Expense Account' : 'Item Details'}</th>
            {priced && <th className="w-24">HSN/SAC</th>}
            {isCount ? <><th className="num w-28">Expected</th><th className="num w-28">Counted</th></>
              : isValueAdj ? <th className="num w-32">New Value (₹)</th>
              : <th className="num w-28">{type === 'inventory_adjustment' ? 'Qty Adjusted (±)' : type === 'purchase_receive' ? 'Received' : 'Quantity'}</th>}
            {type === 'purchase_receive' && <th className="num w-28">Accepted</th>}
            {showRate && <th className="num w-32">{type === 'inventory_adjustment' ? 'Unit Cost (in)' : type === 'purchase_request' ? 'Est. Rate' : 'Rate'}</th>}
            {priced && <th className="num w-20">Disc %</th>}
            {priced && <th className="w-32">Tax</th>}
            {(priced || showRate) && <th className="num w-32">Amount</th>}
            <th className="w-20" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const it = items.find((x) => x.id === l.item_id);
            const needsTracking = it && it.tracking !== 'none' && it.track_inventory;
            return (
              <tr key={i}>
                <td className="pt-3 text-slate-500">{i + 1}</td>
                <td>
                  {expenseOnly || (!l.item_id && l.account_id) ? (
                    <AccountPicker value={l.account_id} onChange={(v) => update(i, { account_id: v, item_id: null })} categories={side === 'sales' ? ['income'] : ['expense', 'asset']} placeholder="Select an account" />
                  ) : (
                    <ItemPicker value={l.item_id} onChange={(id, item) => pickItem(i, id, item)} filter={['package', 'transfer_order', 'inventory_adjustment', 'stock_count', 'purchase_receive', 'sales_return', 'delivery_challan'].includes(type) ? (x) => x.type === 'goods' && x.track_inventory : (x) => x.is_active} disabled={!!l.ref_line_id && !!l.item_id} />
                  )}
                  <input className="input mt-1 text-xs" placeholder="Description" value={l.description ?? ''} onChange={(e) => update(i, { description: e.target.value })} aria-label="Line description" />
                  <div className="mt-1 flex flex-wrap items-center gap-3">
                    {allowAccount && !expenseOnly && !l.item_id && !l.account_id && <button className="text-xs text-brand-600" onClick={() => update(i, { account_id: -1 })}>Use an account instead</button>}
                    {needsTracking && <button className="inline-flex items-center gap-1 text-xs text-brand-600" onClick={() => setTracking(i)}><ListChecks className="h-3.5 w-3.5" />{it.tracking === 'serial' ? 'Serial numbers' : 'Batches'} ({(l.tracking ?? []).length})</button>}
                    {(type === 'bill' || type === 'expense' || type === 'vendor_credit') && priced && <Check label={<span className="text-xs">ITC eligible</span>} checked={l.itc_eligible !== false} onChange={(v) => update(i, { itc_eligible: v })} />}
                    {type === 'bill' && !l.item_id && <Check label={<span className="text-xs">Landed cost</span>} checked={!!l.data?.landed_cost} onChange={(v) => update(i, { data: { ...l.data, landed_cost: v } })} />}
                    {(type === 'credit_note' || type === 'vendor_credit') && it?.track_inventory ? <Check label={<span className="text-xs">{type === 'credit_note' ? 'Return to stock' : 'Goods returned to vendor'}</span>} checked={l.data?.return_to_stock !== false} onChange={(v) => update(i, { data: { ...l.data, return_to_stock: v } })} /> : null}
                  </div>
                </td>
                {priced && <td><input className="input" value={l.hsn_code ?? ''} onChange={(e) => update(i, { hsn_code: e.target.value })} aria-label="HSN/SAC" /></td>}
                {isCount ? (
                  <>
                    <td className="num pt-3">{fq(l.qty)}</td>
                    <td><input className="input text-right" type="number" step="any" value={l.qty2 ?? ''} onChange={(e) => update(i, { qty2: e.target.value })} aria-label="Counted quantity" /></td>
                  </>
                ) : isValueAdj ? (
                  <td><input className="input text-right" type="number" step="any" value={l.qty2 ?? ''} onChange={(e) => update(i, { qty2: e.target.value })} aria-label="New value" /></td>
                ) : (
                  <td>
                    <input className="input text-right" type="number" step="any" value={l.qty ?? ''} onChange={(e) => update(i, { qty: e.target.value })} aria-label="Quantity" />
                    {l.unit && <div className="mt-0.5 text-right text-[11px] text-slate-500">{l.unit}</div>}
                  </td>
                )}
                {type === 'purchase_receive' && <td><input className="input text-right" type="number" step="any" placeholder="All" value={l.qty2 ?? ''} onChange={(e) => update(i, { qty2: e.target.value === '' ? null : e.target.value })} aria-label="Accepted quantity" /></td>}
                {showRate && <td><input className="input text-right" type="number" step="any" value={l.rate ?? ''} onChange={(e) => update(i, { rate: e.target.value })} aria-label="Rate" /></td>}
                {priced && <td><input className="input text-right" type="number" step="any" value={l.discount_pct ?? ''} onChange={(e) => update(i, { discount_pct: e.target.value })} aria-label="Discount percent" /></td>}
                {priced && <td>{l.tax_exempt ? <span className="text-xs capitalize text-slate-500">{l.tax_exempt.replace('_', ' ')}</span> : <TaxSelect value={l.tax_id} onChange={(v) => update(i, { tax_id: v })} />}</td>}
                {(priced || showRate) && <td className="num pt-3 font-medium">{money(priced ? totals.rows[i]?.taxable : r2((Number(l.qty) || 0) * (Number(l.rate) || 0)))}</td>}
                <td className="pt-2"><button className="btn btn-ghost btn-sm" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line"><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 flex gap-2">
        <button className="btn btn-sm" onClick={() => setLines([...lines, { qty: type === 'stock_count' || type === 'inventory_adjustment' ? '' : 1, rate: '', discount_pct: 0, tracking: [] }])}><Plus className="h-3.5 w-3.5" />Add line</button>
      </div>
      {tracking !== null && lines[tracking] && (
        <TrackingModal line={lines[tracking]} item={items.find((x) => x.id === lines[tracking].item_id)} warehouseId={lines[tracking].warehouse_id ?? warehouseId}
          outflow={outflow && !(type === 'inventory_adjustment' && Number(lines[tracking].qty) > 0)} onClose={() => setTracking(null)} onSave={(t) => update(tracking, { tracking: t })} />
      )}
    </div>
  );
}
