const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

export const money = (n: unknown, symbol = '₹') => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '-';
  return `${v < 0 ? '-' : ''}${symbol}${inr.format(Math.abs(v))}`;
};
export const plain = (n: unknown) => inr.format(Number(n ?? 0));
export const qty = (n: unknown) => qtyFmt.format(Number(n ?? 0));
export const date = (s?: string | null) => {
  if (!s) return '-';
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
export const dateTime = (s?: string | null) => (s ? new Date(s.replace(' ', 'T') + (s.includes('Z') || s.includes('+') ? '' : 'Z')).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
export const today = () => new Date().toISOString().slice(0, 10);
export const titleCase = (s?: string | null) => (s ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600', pending_approval: 'bg-amber-100 text-amber-800', rejected: 'bg-red-100 text-red-700',
  sent: 'bg-sky-100 text-sky-800', accepted: 'bg-emerald-100 text-emerald-700', declined: 'bg-red-100 text-red-700', expired: 'bg-slate-200 text-slate-600',
  invoiced: 'bg-violet-100 text-violet-700', confirmed: 'bg-sky-100 text-sky-800', closed: 'bg-slate-200 text-slate-700', void: 'bg-slate-200 text-slate-500 line-through',
  open: 'bg-sky-100 text-sky-800', partially_paid: 'bg-amber-100 text-amber-800', paid: 'bg-emerald-100 text-emerald-700', overdue: 'bg-red-100 text-red-700',
  packed: 'bg-slate-100 text-slate-700', shipped: 'bg-sky-100 text-sky-800', delivered: 'bg-emerald-100 text-emerald-700',
  approved: 'bg-emerald-100 text-emerald-700', received: 'bg-emerald-100 text-emerald-700', credited: 'bg-violet-100 text-violet-700',
  issued: 'bg-sky-100 text-sky-800', cancelled: 'bg-slate-200 text-slate-500', ordered: 'bg-violet-100 text-violet-700', awarded: 'bg-emerald-100 text-emerald-700',
  in_transit: 'bg-amber-100 text-amber-800', transferred: 'bg-emerald-100 text-emerald-700', adjusted: 'bg-emerald-100 text-emerald-700',
  in_progress: 'bg-amber-100 text-amber-800', completed: 'bg-emerald-100 text-emerald-700', recorded: 'bg-emerald-100 text-emerald-700',
  pending_inspection: 'bg-amber-100 text-amber-800', returned: 'bg-slate-200 text-slate-600', pending: 'bg-slate-100 text-slate-600', paused: 'bg-amber-100 text-amber-800',
  active: 'bg-emerald-100 text-emerald-700', disposed: 'bg-slate-200 text-slate-600', fully_depreciated: 'bg-violet-100 text-violet-700',
  passed: 'bg-emerald-100 text-emerald-700', failed: 'bg-red-100 text-red-700', partial: 'bg-amber-100 text-amber-800', generated: 'bg-emerald-100 text-emerald-700',
  uncategorized: 'bg-amber-100 text-amber-800', matched: 'bg-emerald-100 text-emerald-700', categorized: 'bg-sky-100 text-sky-800', excluded: 'bg-slate-200 text-slate-500',
  partially_shipped: 'bg-amber-100 text-amber-800', not_invoiced: 'bg-slate-100 text-slate-600', partially_invoiced: 'bg-amber-100 text-amber-800',
  not_received: 'bg-slate-100 text-slate-600', partially_received: 'bg-amber-100 text-amber-800', not_billed: 'bg-slate-100 text-slate-600', partially_billed: 'bg-amber-100 text-amber-800', billed: 'bg-violet-100 text-violet-700',
  exited: 'bg-slate-200 text-slate-600', inactive: 'bg-slate-200 text-slate-600', stopped: 'bg-slate-200 text-slate-600',
};
export const statusClass = (s?: string | null) => STATUS_COLORS[s ?? ''] ?? 'bg-slate-100 text-slate-600';
