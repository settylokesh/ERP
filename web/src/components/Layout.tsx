import {
  Bell, BookOpen, Boxes, Building2, ChevronDown, ChevronRight, Factory, FileBarChart, Home, Landmark, LogOut, Package, Plus, Receipt,
  Search, Settings, ShieldCheck, ShoppingCart, Users, LayoutGrid, Menu, KeyRound,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { get, post, setToken } from '../api';
import { useCan, useDebounced, useMeta } from '../lib/hooks';
import { dateTime } from '../lib/format';
import { Modal, Field, Input, useAction } from './ui';

type NavItem = { label: string; to: string };
type NavGroup = { key: string; label: string; icon: ReactNode; module?: string; to?: string; items?: NavItem[] };

export function useNav(): NavGroup[] {
  const { meta } = useMeta();
  const custom = meta.custom_modules.map((m) => ({ label: m.plural, to: `/custom/${m.key}` }));
  return [
    { key: 'home', label: 'Home', icon: <Home className="h-4 w-4" />, to: '/' },
    { key: 'items', label: 'Items', icon: <Boxes className="h-4 w-4" />, module: 'items', items: [{ label: 'Items', to: '/items' }, { label: 'Price Lists', to: '/price-lists' }] },
    {
      key: 'inventory', label: 'Inventory', icon: <Package className="h-4 w-4" />, module: 'inventory', items: [
        { label: 'Packages', to: '/docs/package' }, { label: 'Purchase Receives', to: '/docs/purchase_receive' }, { label: 'Transfer Orders', to: '/docs/transfer_order' },
        { label: 'Inventory Adjustments', to: '/docs/inventory_adjustment' }, { label: 'Stock Counts', to: '/docs/stock_count' },
      ],
    },
    {
      key: 'sales', label: 'Sales', icon: <ShoppingCart className="h-4 w-4" />, module: 'sales', items: [
        { label: 'Customers', to: '/customers' }, { label: 'Quotes', to: '/docs/quote' }, { label: 'Sales Orders', to: '/docs/sales_order' },
        { label: 'Delivery Challans', to: '/docs/delivery_challan' }, { label: 'Invoices', to: '/docs/invoice' }, { label: 'Recurring Invoices', to: '/recurring' },
        { label: 'Retainer Invoices', to: '/docs/retainer_invoice' }, { label: 'Payments Received', to: '/payments/received' },
        { label: 'Sales Returns', to: '/docs/sales_return' }, { label: 'Credit Notes', to: '/docs/credit_note' },
      ],
    },
    {
      key: 'purchases', label: 'Purchases', icon: <Receipt className="h-4 w-4" />, module: 'purchases', items: [
        { label: 'Vendors', to: '/vendors' }, { label: 'Purchase Requests', to: '/docs/purchase_request' }, { label: 'Requests for Quote', to: '/docs/rfq' },
        { label: 'Purchase Orders', to: '/docs/purchase_order' }, { label: 'Bills', to: '/docs/bill' }, { label: 'Payments Made', to: '/payments/made' },
        { label: 'Vendor Credits', to: '/docs/vendor_credit' }, { label: 'Expenses', to: '/docs/expense' },
      ],
    },
    {
      key: 'manufacturing', label: 'Manufacturing', icon: <Factory className="h-4 w-4" />, module: 'manufacturing', items: [
        { label: 'Manufacturing Orders', to: '/manufacturing/orders' }, { label: 'Bills of Materials', to: '/manufacturing/boms' }, { label: 'Shop Floor', to: '/manufacturing/shop-floor' },
        { label: 'Work Centre Calendar', to: '/manufacturing/calendar' }, { label: 'Work Centres', to: '/manufacturing/work-centers' },
        { label: 'Quality', to: '/manufacturing/quality' }, { label: 'Material Planning', to: '/manufacturing/mrp' },
      ],
    },
    { key: 'banking', label: 'Banking', icon: <Landmark className="h-4 w-4" />, module: 'banking', to: '/banking' },
    {
      key: 'accountant', label: 'Accountant', icon: <BookOpen className="h-4 w-4" />, module: 'accountant', items: [
        { label: 'Chart of Accounts', to: '/accountant/accounts' }, { label: 'Manual Journals', to: '/accountant/journals' },
        { label: 'Budgets', to: '/accountant/budgets' }, { label: 'Transaction Locking', to: '/accountant/locking' },
      ],
    },
    { key: 'assets', label: 'Fixed Assets', icon: <Building2 className="h-4 w-4" />, module: 'assets', to: '/assets' },
    { key: 'payroll', label: 'People & Payroll', icon: <Users className="h-4 w-4" />, module: 'payroll', items: [{ label: 'Employees', to: '/payroll/employees' }, { label: 'Pay Runs', to: '/payroll/pay-runs' }] },
    {
      key: 'compliance', label: 'Filing & Compliance', icon: <ShieldCheck className="h-4 w-4" />, module: 'compliance', items: [
        { label: 'GSTR-1', to: '/compliance/gstr1' }, { label: 'GSTR-3B', to: '/compliance/gstr3b' }, { label: 'GSTR-2B Reconciliation', to: '/compliance/gstr2b' },
        { label: 'e-Invoices & e-Way Bills', to: '/compliance/einvoices' },
      ],
    },
    { key: 'reports', label: 'Reports', icon: <FileBarChart className="h-4 w-4" />, module: 'reports', to: '/reports' },
    ...(custom.length ? [{ key: 'custom', label: 'Custom Modules', icon: <LayoutGrid className="h-4 w-4" />, module: 'custom', items: custom }] : []),
  ];
}

function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const nav = useNav();
  const can = useCan();
  const loc = useLocation();
  const activeGroup = useMemo(() => nav.find((g) => g.items?.some((i) => loc.pathname === i.to || loc.pathname.startsWith(i.to + '/')))?.key, [nav, loc.pathname]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => { if (activeGroup) setExpanded((e) => ({ ...e, [activeGroup]: true })); }, [activeGroup]);
  const { meta } = useMeta();
  return (
    <aside className={`no-print fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-side text-side-text transition-transform lg:static lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="flex items-center gap-2 px-4 py-4">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">Saral ERP</div>
          <div className="truncate text-[11px] text-slate-400">{meta.org.name}</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4" aria-label="Main">
        {nav.filter((g) => !g.module || can(g.module)).map((g) => g.to ? (
          <NavLink key={g.key} to={g.to} end={g.to === '/'} onClick={onNavigate}
            className={({ isActive }) => `flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium no-underline ${isActive ? 'bg-brand-600 text-white' : 'text-side-text hover:bg-side-hover hover:text-white'}`}>
            {g.icon}{g.label}
          </NavLink>
        ) : (
          <div key={g.key}>
            <button onClick={() => setExpanded((e) => ({ ...e, [g.key]: !e[g.key] }))}
              className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] font-medium hover:bg-side-hover hover:text-white ${activeGroup === g.key ? 'text-white' : ''}`} aria-expanded={!!expanded[g.key]}>
              {g.icon}<span className="flex-1">{g.label}</span>{expanded[g.key] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
            {expanded[g.key] && (
              <div className="mb-1 ml-6 border-l border-slate-600/50 pl-2">
                {g.items!.map((i) => (
                  <NavLink key={i.to} to={i.to} onClick={onNavigate}
                    className={({ isActive }) => `block rounded-md px-3 py-1.5 text-[12.5px] no-underline ${isActive || loc.pathname.startsWith(i.to + '/') ? 'bg-side-active font-medium text-white' : 'text-side-text hover:text-white'}`}>
                    {i.label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
    </aside>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q);
  const nav = useNavigate();
  useEffect(() => {
    if (dq.length < 2) { setResults([]); return; }
    get(`/search?q=${encodeURIComponent(dq)}`).then(setResults).catch(() => setResults([]));
  }, [dq]);
  return (
    <div className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-slate-400" />
      <input className="input pl-8" placeholder="Search transactions, contacts, items…" value={q} aria-label="Global search"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)} />
      {open && results.length > 0 && (
        <div className="card absolute left-0 right-0 top-9 z-50 max-h-96 overflow-y-auto py-1">
          {results.map((r, i) => (
            <button key={i} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50" onMouseDown={() => { nav(r.link); setQ(''); setOpen(false); }}>
              <span><span className="font-medium">{r.label}</span> <span className="text-xs text-slate-500">{r.sub}</span></span>
              <span className="chip bg-slate-100 text-slate-600 capitalize">{r.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const { meta, reload } = useMeta();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) get('/notifications').then(setItems); }, [open]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button className="btn btn-ghost relative" onClick={() => setOpen(!open)} aria-label="Notifications">
        <Bell className="h-4 w-4" />
        {meta.unread_notifications > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white">{meta.unread_notifications}</span>}
      </button>
      {open && (
        <div className="card absolute right-0 top-10 z-50 w-80">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="font-semibold">Notifications</span>
            <button className="text-xs text-brand-600" onClick={async () => { await post('/notifications/read-all'); setItems(items.map((n) => ({ ...n, is_read: 1 }))); reload(); }}>Mark all read</button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 && <div className="p-4 text-center text-slate-500">You're all caught up.</div>}
            {items.map((n) => (
              <button key={n.id} className={`block w-full border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50 ${n.is_read ? 'opacity-60' : ''}`}
                onClick={async () => { await post(`/notifications/${n.id}/read`); setOpen(false); reload(); if (n.link) nav(n.link); }}>
                <div className="font-medium">{n.title}</div>
                {n.body && <div className="text-xs text-slate-500">{n.body}</div>}
                <div className="mt-0.5 text-[11px] text-slate-500">{dateTime(n.at)}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const QUICK: { label: string; to: string; module: string }[] = [
  { label: 'Invoice', to: '/docs/invoice/new', module: 'sales' }, { label: 'Quote', to: '/docs/quote/new', module: 'sales' },
  { label: 'Sales Order', to: '/docs/sales_order/new', module: 'sales' }, { label: 'Customer', to: '/customers/new', module: 'sales' },
  { label: 'Payment Received', to: '/payments/received/new', module: 'sales' }, { label: 'Bill', to: '/docs/bill/new', module: 'purchases' },
  { label: 'Purchase Order', to: '/docs/purchase_order/new', module: 'purchases' }, { label: 'Expense', to: '/docs/expense/new', module: 'purchases' },
  { label: 'Vendor', to: '/vendors/new', module: 'purchases' }, { label: 'Item', to: '/items/new', module: 'items' },
  { label: 'Manufacturing Order', to: '/manufacturing/orders/new', module: 'manufacturing' }, { label: 'Manual Journal', to: '/accountant/journals/new', module: 'accountant' },
];

function QuickCreate() {
  const [open, setOpen] = useState(false);
  const can = useCan();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button className="btn btn-primary" onClick={() => setOpen(!open)} aria-label="Quick create"><Plus className="h-4 w-4" /></button>
      {open && (
        <div className="card absolute right-0 top-10 z-50 grid w-80 grid-cols-2 gap-0.5 p-2">
          {QUICK.filter((q) => can(q.module, 'create')).map((q) => (
            <Link key={q.to} to={q.to} onClick={() => setOpen(false)} className="rounded px-2 py-1.5 text-[13px] text-slate-700 no-underline hover:bg-slate-100">+ {q.label}</Link>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { meta } = useMeta();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  const [form, setForm] = useState({ current: '', next: '' });
  const { run, busy } = useAction();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const logout = async () => { try { await post('/auth/logout'); } catch { /* ignore */ } setToken(''); window.location.href = '/login'; };
  return (
    <div className="relative" ref={ref}>
      <button className="flex items-center gap-2 rounded-full bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white" onClick={() => setOpen(!open)} aria-label="User menu">
        {meta.user.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
      </button>
      {open && (
        <div className="card absolute right-0 top-10 z-50 w-60 p-2">
          <div className="border-b px-2 pb-2"><div className="font-medium">{meta.user.name}</div><div className="text-xs text-slate-500">{meta.user.email}</div><div className="text-xs text-slate-500">{meta.user.role_name}</div></div>
          <button className="mt-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-slate-100" onClick={() => { setPw(true); setOpen(false); }}><KeyRound className="h-4 w-4" />Change password</button>
          <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-red-600 hover:bg-red-50" onClick={logout}><LogOut className="h-4 w-4" />Sign out</button>
        </div>
      )}
      {pw && (
        <Modal title="Change password" onClose={() => setPw(false)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => post('/auth/password', form), 'Password changed')) setPw(false); }}>Update</button>}>
          <div className="space-y-3">
            <Field label="Current password"><Input type="password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} /></Field>
            <Field label="New password" hint="At least 8 characters"><Input type="password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Shown instead of the app while the signed-in user must replace a temporary or former default password. */
function RequiredPasswordChange() {
  const { meta, reload } = useMeta();
  const nav = useNavigate();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.next !== form.confirm) { setError('New passwords do not match'); return; }
    setError(null);
    if (await run(() => post('/auth/password', { current: form.current, next: form.next }), 'Password changed')) await reload();
  };
  return (
    <div className="flex min-h-full items-center justify-center bg-slate-100 p-4">
      <form className="card w-full max-w-md space-y-4 p-6" onSubmit={submit}>
        <div>
          <h1 className="text-lg">Choose a new password</h1>
          <p className="mt-1 text-slate-600">Hello {meta.user.name}. Your password was set by an administrator or is a former default, so it must be changed before you continue.</p>
        </div>
        {error && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-red-700">{error}</p>}
        <Field label="Current password"><Input type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} required /></Field>
        <Field label="New password" hint="At least 8 characters"><Input type="password" autoComplete="new-password" minLength={8} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} required /></Field>
        <Field label="Confirm new password"><Input type="password" autoComplete="new-password" minLength={8} value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required /></Field>
        <div className="flex gap-2">
          <button className="btn btn-primary" disabled={busy}>Change password</button>
          <button type="button" className="btn" onClick={async () => { await post('/auth/logout').catch(() => undefined); setToken(''); nav('/login'); window.location.reload(); }}>Sign out</button>
        </div>
      </form>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const can = useCan();
  const { meta } = useMeta();
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  if (meta.user.must_change_password) return <RequiredPasswordChange />;
  return (
    <div className="flex h-full">
      <Sidebar open={open} onNavigate={() => setOpen(false)} />
      {open && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
          <button className="btn btn-ghost lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="h-4 w-4" /></button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-1">
            <QuickCreate />
            <Notifications />
            {can('settings') && <Link to="/settings" className="btn btn-ghost" aria-label="Settings"><Settings className="h-4 w-4" /></Link>}
            <UserMenu />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
