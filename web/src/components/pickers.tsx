import { ChevronDown, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi, useMeta } from '../lib/hooks';
import { money } from '../lib/format';
import { Select } from './ui';

export interface ComboOption { value: number | string; label: string; sub?: string; group?: string }

/** Searchable single-select. */
export function Combo({ options, value, onChange, placeholder = 'Select…', disabled, allowClear = true, ariaLabel, footer }: {
  options: ComboOption[]; value: number | string | null | undefined; onChange: (v: any, o?: ComboOption) => void; placeholder?: string; disabled?: boolean; allowClear?: boolean; ariaLabel?: string; footer?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => String(o.value) === String(value ?? ''));
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? options.filter((o) => `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(s)) : options).slice(0, 200);
  }, [q, options]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  useEffect(() => setHi(0), [q, open]);
  const pick = (o: ComboOption) => { onChange(o.value, o); setOpen(false); setQ(''); };
  return (
    <div className="relative" ref={ref}>
      <div className={`input flex cursor-pointer items-center gap-1 ${disabled ? 'bg-slate-100' : ''}`} onClick={() => !disabled && setOpen(true)}>
        {open ? (
          <input autoFocus className="min-w-0 flex-1 bg-transparent outline-none" value={q} placeholder={selected?.label ?? placeholder} aria-label={ariaLabel ?? placeholder}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, filtered.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); if (filtered[hi]) pick(filtered[hi]); }
              else if (e.key === 'Escape') setOpen(false);
            }} />
        ) : (
          <span className={`min-w-0 flex-1 truncate ${selected ? '' : 'text-slate-400'}`} role="combobox" aria-label={ariaLabel ?? placeholder} aria-expanded={false} tabIndex={disabled ? -1 : 0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}>
            {selected ? selected.label : placeholder}
          </span>
        )}
        {allowClear && selected && !disabled && <X className="h-3.5 w-3.5 text-slate-400 hover:text-slate-700" onClick={(e) => { e.stopPropagation(); onChange(null); }} />}
        <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
      </div>
      {open && (
        <div className="card absolute left-0 right-0 top-full z-50 mt-1 max-h-72 min-w-[16rem] overflow-y-auto py-1" role="listbox">
          {filtered.length === 0 && <div className="px-3 py-2 text-slate-500">No matches</div>}
          {filtered.map((o, i) => (
            <div key={`${o.value}`} role="option" aria-selected={String(o.value) === String(value)}
              className={`cursor-pointer px-3 py-1.5 ${i === hi ? 'bg-brand-50' : ''} ${String(o.value) === String(value) ? 'font-medium text-brand-700' : ''}`}
              onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
              <div className="truncate">{o.label}</div>
              {o.sub && <div className="truncate text-[11px] text-slate-500">{o.sub}</div>}
            </div>
          ))}
          {footer}
        </div>
      )}
    </div>
  );
}

export function useContacts(kind: 'customer' | 'vendor' | null) {
  const { data, reload } = useApi<any[]>(kind ? `/contacts?kind=${kind}` : null);
  return { contacts: data ?? [], reload };
}
export function ContactPicker({ kind, value, onChange, disabled }: { kind: 'customer' | 'vendor'; value: any; onChange: (id: number | null, c?: any) => void; disabled?: boolean }) {
  const { contacts } = useContacts(kind);
  const opts = contacts.map((c) => ({ value: c.id, label: c.name, sub: [c.gstin, c.email].filter(Boolean).join(' · ') }));
  return <Combo options={opts} value={value} disabled={disabled} ariaLabel={kind === 'customer' ? 'Customer' : 'Vendor'} placeholder={`Select ${kind}`} onChange={(v) => onChange(v, contacts.find((c) => c.id === v))} />;
}

let itemCache: any[] | null = null;
export function useItems() {
  const { data, reload } = useApi<any[]>('/items');
  useEffect(() => { if (data) itemCache = data; }, [data]);
  return { items: data ?? itemCache ?? [], reload };
}
export function ItemPicker({ value, onChange, filter, disabled }: { value: any; onChange: (id: number | null, item?: any) => void; filter?: (i: any) => boolean; disabled?: boolean }) {
  const { items } = useItems();
  const list = filter ? items.filter(filter) : items;
  const opts = list.map((i) => ({ value: i.id, label: i.name, sub: `${i.sku ?? ''}${i.track_inventory ? ` · Stock ${i.stock_on_hand} ${i.unit}` : ''} · ${money(i.sales_rate)}` }));
  return <Combo options={opts} value={value} disabled={disabled} ariaLabel="Item" placeholder="Type or click to select an item" onChange={(v) => onChange(v, items.find((i) => i.id === v))} />;
}

export function useAccounts() {
  const { data, reload } = useApi<any[]>('/accounts');
  return { accounts: data ?? [], reload };
}
export function AccountPicker({ value, onChange, types, categories, placeholder = 'Select an account', disabled }: { value: any; onChange: (id: number | null) => void; types?: string[]; categories?: string[]; placeholder?: string; disabled?: boolean }) {
  const { accounts } = useAccounts();
  const { meta } = useMeta();
  const list = accounts.filter((a) => (!types || types.includes(a.type)) && (!categories || categories.includes(a.category)));
  return <Combo options={list.map((a) => ({ value: a.id, label: a.name, sub: `${a.code ?? ''} · ${meta.account_types[a.type]?.label ?? a.type}` }))} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} ariaLabel={placeholder} />;
}

export function WarehouseSelect({ value, onChange, placeholder }: { value: any; onChange: (id: number | null) => void; placeholder?: string }) {
  const { meta } = useMeta();
  return <Select aria-label="Warehouse" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} placeholder={placeholder} options={meta.warehouses.map((w) => ({ value: w.id, label: w.name }))} />;
}
export function TaxSelect({ value, onChange }: { value: any; onChange: (id: number | null) => void }) {
  const { meta } = useMeta();
  return <Select aria-label="Tax" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} placeholder="Non-taxable" options={meta.taxes.filter((t) => t.is_active || t.id === value).map((t) => ({ value: t.id, label: `${t.rate}%` }))} />;
}
export function StateSelect({ value, onChange, includeForeign }: { value: any; onChange: (v: string) => void; includeForeign?: boolean }) {
  const { meta } = useMeta();
  return <Select aria-label="State" value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="Select state"
    options={Object.entries(meta.states).filter(([k]) => includeForeign || k !== '96').map(([k, v]) => ({ value: k, label: `[${k}] ${v}` }))} />;
}
export function EmployeeSelect({ value, onChange }: { value: any; onChange: (id: number | null) => void }) {
  const { data } = useApi<any[]>('/payroll/employees');
  return <Combo options={(data ?? []).map((e) => ({ value: e.id, label: e.name, sub: e.emp_code }))} value={value} onChange={onChange} placeholder="Assign employee" />;
}
