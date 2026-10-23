import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, post, put } from '../../api';
import { computeTotals, LineItems, type Line } from '../../components/LineItems';
import { AccountPicker, ContactPicker, StateSelect, WarehouseSelect, useContacts } from '../../components/pickers';
import { Check, ErrorBox, Field, Input, PageHeader, Select, Spinner, Textarea, useAction } from '../../components/ui';
import { money, today } from '../../lib/format';
import { useMeta } from '../../lib/hooks';

const SUBMIT_LABEL: Record<string, string> = {
  quote: 'Save and Send', sales_order: 'Save and Confirm', invoice: 'Save and Send', credit_note: 'Save as Open', purchase_order: 'Save and Issue',
  bill: 'Save as Open', vendor_credit: 'Save as Open', purchase_request: 'Save and Submit', rfq: 'Save', expense: 'Save',
  transfer_order: 'Initiate Transfer', inventory_adjustment: 'Save as Adjusted', stock_count: 'Save', retainer_invoice: 'Save and Send', delivery_challan: 'Save as Open',
};

export function CustomFieldInputs({ module, value, onChange }: { module: string; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  const { meta } = useMeta();
  const fields = meta.custom_fields.filter((f) => f.module === module);
  if (!fields.length) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {fields.map((f) => (
        <Field key={f.key} label={f.label} required={!!f.required}>
          {f.type === 'dropdown' ? <Select value={value[f.key] ?? ''} placeholder="Select" options={f.options.map((o: string) => ({ value: o, label: o }))} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
            : f.type === 'checkbox' ? <div className="pt-1"><Check label="" checked={!!value[f.key]} onChange={(v) => onChange({ ...value, [f.key]: v })} /></div>
            : <Input type={f.type === 'date' ? 'date' : ['number', 'decimal', 'currency'].includes(f.type) ? 'number' : 'text'} value={value[f.key] ?? ''} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />}
        </Field>
      ))}
    </div>
  );
}

export default function DocForm() {
  const { type = '', id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { meta } = useMeta();
  const def = meta.doc_types[type];
  const { run, busy } = useAction();
  const [form, setForm] = useState<any>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { contacts } = useContacts(def?.party ?? null);
  const { contacts: vendors } = useContacts(type === 'rfq' || type === 'purchase_request' ? 'vendor' : null);

  useEffect(() => {
    (async () => {
      try {
        if (id) {
          const d = await get(`/docs/${type}/${id}`);
          setForm({ ...d, data: d.data ?? {}, custom: d.custom ?? {} });
          setLines(d.lines.map((l: any) => ({ ...l, itc_eligible: !!l.itc_eligible })));
        } else if (sp.get('clone')) {
          const d = await get(`/docs/${type}/${sp.get('clone')}`);
          const { id: _i, number: _n, status: _s, ...rest } = d;
          void _i; void _n; void _s;
          setForm({ ...rest, ref_doc_id: null, date: today(), due_date: null, data: { ...(d.data ?? {}), einvoice: undefined, ewaybill: undefined, shipment: undefined }, custom: d.custom ?? {} });
          setLines(d.lines.map(({ id: _l, ref_line_id: _r, tracking: _t, ...l }: any) => ({ ...l, itc_eligible: !!l.itc_eligible, tracking: [] })));
        } else if (sp.get('from')) {
          const d = await get(`/docs/${sp.get('from_type')}/${sp.get('from')}/convert/${type}${sp.get('vendor_id') ? `?vendor_id=${sp.get('vendor_id')}` : ''}`);
          setForm({ ...d, data: d.data ?? {}, custom: {} });
          setLines(d.lines);
        } else {
          setForm({ date: today(), contact_id: sp.get('contact') ? Number(sp.get('contact')) : null, warehouse_id: meta.warehouses[0]?.id ?? null, adjustment: 0, data: type === 'inventory_adjustment' ? { mode: 'quantity' } : {}, custom: {}, terms: type === 'invoice' ? meta.org.invoice_terms : '', notes: ['invoice', 'quote'].includes(type) ? meta.org.invoice_notes : '' });
          const item = sp.get('item') ? Number(sp.get('item')) : null;
          setLines([{ item_id: item, qty: sp.get('qty') ? Number(sp.get('qty')) : type === 'stock_count' ? 0 : type === 'inventory_adjustment' ? '' : 1, rate: '', discount_pct: 0, tracking: [] }]);
        }
      } catch (e: any) { setError(e.message); }
    })();
  }, [type, id, sp, meta.warehouses, meta.org]);

  const contact = contacts.find((c) => c.id === form?.contact_id);
  const set = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));
  const setData = (patch: any) => setForm((f: any) => ({ ...f, data: { ...f.data, ...patch } }));
  const ourState = useMemo(() => meta.warehouses.find((w) => w.id === form?.warehouse_id)?.state_code || meta.org.state_code, [form?.warehouse_id, meta]);
  const kind: 'intra' | 'inter' | 'none' = useMemo(() => {
    if (!def?.priced) return 'none';
    const gt = contact?.gst_treatment;
    if (gt === 'overseas') return def.side === 'sales' ? (form?.data?.export_with_payment ? 'inter' : 'none') : form?.reverse_charge ? 'inter' : 'none';
    if (gt === 'sez' && def.side === 'sales') return form?.data?.export_with_payment ? 'inter' : 'none';
    if (def.side === 'purchase' && ['business_none', 'business_composition', 'consumer'].includes(gt) && !form?.reverse_charge) return 'none';
    const pos = form?.place_of_supply ?? contact?.place_of_supply ?? meta.org.state_code;
    return !pos || pos === ourState ? 'intra' : 'inter';
  }, [def, contact, form, ourState, meta.org.state_code]);

  if (!def) return <div className="p-6"><ErrorBox error={`Unknown document type ${type}`} /></div>;
  if (error) return <div className="p-6"><ErrorBox error={error} /></div>;
  if (!form) return <Spinner />;

  const tdsRate = type === 'bill' && form.data?.tds_section_id ? meta.tds_sections.find((t) => t.id === Number(form.data.tds_section_id))?.rate : 0;
  const totals = computeTotals(lines, { kind, inclusive: !!form.tax_inclusive, taxes: meta.taxes, adjustment: Number(form.adjustment) || 0, reverseCharge: !!form.reverse_charge, tdsRate });
  const fmt = (n: number) => money(n, form.currency_code && form.currency_code !== 'INR' ? `${form.currency_code} ` : '₹');

  const onContact = (cid: number | null, c?: any) => {
    set({ contact_id: cid, place_of_supply: c?.place_of_supply ?? null, currency_code: c?.currency_code ?? 'INR', exchange_rate: c && c.currency_code !== 'INR' ? meta.currencies.find((x) => x.code === c.currency_code)?.rate : 1, payment_terms: c?.payment_terms, due_date: null });
    if (type === 'bill' && c?.tds_section_id) setData({ tds_section_id: c.tds_section_id });
  };

  const save = async (submit: boolean) => {
    // Stock counts and RFQs start as drafts; counting and publishing are explicit actions.
    const payload = {
      ...form, submit: ['stock_count', 'rfq'].includes(type) ? false : submit, data: form.data, custom: form.custom,
      lines: lines.filter((l) => l.item_id || (l.account_id && l.account_id > 0) || l.description).map((l) => ({
        ...l, account_id: l.account_id && l.account_id > 0 ? l.account_id : null,
        qty: l.qty === '' || l.qty == null ? undefined : Number(l.qty), rate: l.rate === '' || l.rate == null ? undefined : Number(l.rate),
        qty2: l.qty2 === '' || l.qty2 == null ? null : Number(l.qty2), discount_pct: Number(l.discount_pct) || 0,
      })),
    };
    const res = await run(() => (id ? put(`/docs/${type}/${id}`, payload) : post(`/docs/${type}`, payload)), `${def.label} saved`);
    if (res) nav(`/docs/${type}/${res.id}`, { replace: true });
  };

  const isPurchase = def.side === 'purchase';
  return (
    <div className="pb-24">
      <PageHeader title={`${id ? 'Edit' : 'New'} ${def.label}`} subtitle={form.number}
        back={<Link to={id ? `/docs/${type}/${id}` : `/docs/${type}`} className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />{def.plural}</Link>} />
      <div className="space-y-5 p-5">
        {form.ref_doc_id && <div className="rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-700">Created from {form.ref_doc?.number ?? form.reference ?? `#${form.ref_doc_id}`}</div>}
        <div className="card grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {def.party && (
            <Field label={def.party === 'vendor' ? 'Vendor Name' : 'Customer Name'} required={def.partyRequired}>
              <ContactPicker kind={def.party} value={form.contact_id} onChange={onContact} disabled={!!form.ref_doc_id && ['package', 'sales_return', 'purchase_receive'].includes(type)} />
              {contact && <div className="mt-1 text-[11px] text-slate-500">{meta.gst_treatments[contact.gst_treatment]}{contact.gstin ? ` · ${contact.gstin}` : ''} · Balance {money(contact.balance)}</div>}
            </Field>
          )}
          {(def.priced || type === 'delivery_challan') && contact && contact.gst_treatment !== 'overseas' && (
            <Field label={isPurchase ? 'Source of Supply' : 'Place of Supply'}><StateSelect value={form.place_of_supply ?? contact.place_of_supply} onChange={(v) => set({ place_of_supply: v })} /></Field>
          )}
          <Field label={`${def.label} Date`} required><Input type="date" value={form.date ?? ''} onChange={(e) => set({ date: e.target.value })} /></Field>
          {def.dueDate && <Field label={type === 'quote' ? 'Expiry Date' : type === 'sales_order' ? 'Expected Shipment Date' : type === 'purchase_order' ? 'Expected Delivery Date' : type === 'rfq' ? 'Bid Deadline' : 'Due Date'} hint={def.party && !form.due_date ? `Defaults to payment terms (${form.payment_terms ?? contact?.payment_terms ?? 0} days)` : undefined}>
            <Input type="date" value={form.due_date ?? ''} onChange={(e) => set({ due_date: e.target.value || null })} /></Field>}
          {def.warehouse && <Field label={type === 'transfer_order' ? 'Source Warehouse' : 'Warehouse'}><WarehouseSelect value={form.warehouse_id} onChange={(v) => set({ warehouse_id: v })} /></Field>}
          {type === 'transfer_order' && <Field label="Destination Warehouse" required><WarehouseSelect value={form.to_warehouse_id} onChange={(v) => set({ to_warehouse_id: v })} placeholder="Select" /></Field>}
          <Field label={isPurchase ? 'Vendor Invoice # / Reference' : 'Reference #'}><Input value={form.reference ?? ''} onChange={(e) => set({ reference: e.target.value })} /></Field>
          {def.side === 'sales' && def.priced && <Field label="Salesperson"><Input value={form.salesperson ?? ''} onChange={(e) => set({ salesperson: e.target.value })} /></Field>}
          {form.currency_code && form.currency_code !== 'INR' && <Field label={`Exchange rate (1 ${form.currency_code} = ₹)`}><Input type="number" step="any" value={form.exchange_rate ?? ''} onChange={(e) => set({ exchange_rate: Number(e.target.value) })} /></Field>}
          {type === 'expense' && <Field label="Paid Through" required><AccountPicker value={form.data.paid_through_account_id} onChange={(v) => setData({ paid_through_account_id: v })} types={['bank', 'cash', 'credit_card']} /></Field>}
          {type === 'bill' && <Field label="TDS"><Select value={form.data.tds_section_id ?? ''} placeholder="No TDS" onChange={(e) => setData({ tds_section_id: e.target.value ? Number(e.target.value) : null })} options={meta.tds_sections.map((t) => ({ value: t.id, label: `${t.section} - ${t.name} (${t.rate}%)` }))} /></Field>}
          {type === 'bill' && <Field label="Landed cost allocation"><Select value={form.data.landed_method ?? 'value'} onChange={(e) => setData({ landed_method: e.target.value })} options={[{ value: 'value', label: 'By value' }, { value: 'quantity', label: 'By quantity' }]} /></Field>}
          {type === 'inventory_adjustment' && (
            <>
              <Field label="Mode of adjustment"><Select value={form.data.mode ?? 'quantity'} onChange={(e) => setData({ mode: e.target.value })} options={[{ value: 'quantity', label: 'Quantity adjustment' }, { value: 'value', label: 'Value adjustment' }]} /></Field>
              <Field label="Reason" required><Select value={form.data.reason ?? ''} placeholder="Select a reason" onChange={(e) => setData({ reason: e.target.value })} options={['Stock on fire', 'Stolen goods', 'Damaged goods', 'Stock written off', 'Stocktaking results', 'Inventory revaluation', 'Opening stock correction'].map((r) => ({ value: r, label: r }))} /></Field>
              <Field label="Account"><AccountPicker value={form.data.account_id} onChange={(v) => setData({ account_id: v })} categories={['expense', 'income', 'equity']} placeholder="Inventory Adjustments" /></Field>
            </>
          )}
          {type === 'delivery_challan' && <Field label="Challan Type"><Select value={form.data.challan_type ?? 'Supply on approval'} onChange={(e) => setData({ challan_type: e.target.value })} options={['Supply on approval', 'Job work', 'Supply of liquid gas', 'Branch transfer', 'Others'].map((r) => ({ value: r, label: r }))} /></Field>}
          {type === 'purchase_request' && <Field label="Requested By / Department"><Input value={form.data.requested_by ?? ''} onChange={(e) => setData({ requested_by: e.target.value })} /></Field>}
          {type === 'rfq' && (
            <Field label="Invite Vendors" className="sm:col-span-2">
              <div className="flex flex-wrap gap-2 rounded-md border border-slate-200 p-2">
                {vendors.map((v) => <Check key={v.id} label={v.name} checked={(form.data.vendor_ids ?? []).includes(v.id)} onChange={(on) => setData({ vendor_ids: on ? [...(form.data.vendor_ids ?? []), v.id] : (form.data.vendor_ids ?? []).filter((x: number) => x !== v.id) })} />)}
              </div>
            </Field>
          )}
          <div className="flex flex-wrap items-end gap-4 sm:col-span-2 lg:col-span-3">
            {def.priced && <Check label="Rates are tax inclusive" checked={!!form.tax_inclusive} onChange={(v) => set({ tax_inclusive: v })} />}
            {isPurchase && def.priced && <Check label="Subject to reverse charge" checked={!!form.reverse_charge} onChange={(v) => set({ reverse_charge: v })} />}
            {def.side === 'sales' && (contact?.gst_treatment === 'overseas' || contact?.gst_treatment === 'sez') && def.priced && <Check label="Export with payment of IGST (else LUT)" checked={!!form.data.export_with_payment} onChange={(v) => setData({ export_with_payment: v })} />}
          </div>
        </div>

        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3>Line items</h3>
            {def.priced && <span className="text-xs text-slate-500">{kind === 'intra' ? 'Intra-state: CGST + SGST' : kind === 'inter' ? 'Inter-state: IGST' : 'No GST applies'}</span>}
          </div>
          <LineItems type={type} lines={lines} setLines={setLines} priced={def.priced} side={def.side} kind={kind} inclusive={!!form.tax_inclusive} warehouseId={form.warehouse_id} mode={form.data?.mode} priceList={contact?.price_list_id} />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="card space-y-3 p-4">
            <Field label={def.side === 'purchase' ? 'Notes' : 'Customer Notes'}><Textarea value={form.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} /></Field>
            {def.priced && <Field label="Terms & Conditions"><Textarea value={form.terms ?? ''} onChange={(e) => set({ terms: e.target.value })} /></Field>}
            <CustomFieldInputs module={type} value={form.custom ?? {}} onChange={(v) => set({ custom: v })} />
          </div>
          {(def.priced || ['purchase_request', 'retainer_invoice'].includes(type)) && (
            <div className="card space-y-2 p-4 text-[13px]">
              <div className="flex justify-between"><span>Sub Total</span><span className="tabular-nums">{fmt(def.priced ? totals.taxable : lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0))}</span></div>
              {totals.discount > 0 && <div className="flex justify-between text-slate-500"><span>Discount (included)</span><span className="tabular-nums">-{fmt(totals.discount)}</span></div>}
              {totals.cgst > 0 && <div className="flex justify-between"><span>CGST</span><span className="tabular-nums">{fmt(totals.cgst)}</span></div>}
              {totals.sgst > 0 && <div className="flex justify-between"><span>SGST</span><span className="tabular-nums">{fmt(totals.sgst)}</span></div>}
              {totals.igst > 0 && <div className="flex justify-between"><span>IGST</span><span className="tabular-nums">{fmt(totals.igst)}</span></div>}
              {form.reverse_charge && totals.tax > 0 && <div className="text-xs text-amber-700">GST of {fmt(totals.tax)} is payable by you under reverse charge and is not part of the vendor's total.</div>}
              {def.priced && <div className="flex items-center justify-between gap-3"><span>Adjustment</span><input className="input w-32 text-right" type="number" step="any" value={form.adjustment ?? 0} onChange={(e) => set({ adjustment: e.target.value })} aria-label="Adjustment" /></div>}
              {totals.tds > 0 && <div className="flex justify-between"><span>TDS</span><span className="tabular-nums">-{fmt(totals.tds)}</span></div>}
              <div className="flex justify-between border-t pt-2 text-base font-semibold"><span>Total</span><span className="tabular-nums">{fmt(def.priced ? totals.total : lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0))}</span></div>
              {form.currency_code && form.currency_code !== 'INR' && <div className="text-right text-xs text-slate-500">≈ {money(totals.total * (Number(form.exchange_rate) || 1))}</div>}
            </div>
          )}
        </div>
      </div>
      <div className="no-print fixed bottom-0 left-0 right-0 z-20 flex justify-start gap-2 border-t border-slate-200 bg-white px-5 py-3 lg:left-60">
        {(!id || form.status === 'draft' || form.status === 'rejected') && !['package', 'sales_return', 'purchase_receive'].includes(type) && (
          <button className="btn" disabled={busy} onClick={() => save(false)}>Save as Draft</button>
        )}
        <button className="btn btn-primary" disabled={busy} onClick={() => save(!id || form.status === 'draft' || form.status === 'rejected')}>
          {id && form.status !== 'draft' ? 'Save' : SUBMIT_LABEL[type] ?? 'Save'}
        </button>
        <button className="btn" onClick={() => nav(-1)}>Cancel</button>
      </div>
    </div>
  );
}
