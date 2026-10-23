import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { get } from '../api';

/** Loads JSON from the API; re-fetches when the path changes. */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) { setLoading(false); return; }
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await get<T>(path);
      if (n === seq.current) { setData(d); setError(null); }
    } catch (e: any) {
      if (n === seq.current) setError(e.message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface Meta {
  user: { id: number; name: string; email: string; role_name: string; is_admin: boolean; must_change_password?: boolean; permissions: Record<string, Record<string, boolean>> };
  org: any;
  doc_types: Record<string, any>;
  states: Record<string, string>;
  gst_treatments: Record<string, string>;
  account_types: Record<string, { label: string; category: string }>;
  taxes: any[];
  tds_sections: any[];
  warehouses: any[];
  currencies: any[];
  price_lists: any[];
  custom_fields: any[];
  custom_modules: any[];
  bank_txn_kinds: Record<string, { label: string; direction: string }>;
  approvals: Record<string, any>;
  lock_dates: Record<string, string>;
  unread_notifications: number;
}

const MetaCtx = createContext<{ meta: Meta; reload: () => Promise<void> } | null>(null);
export function MetaProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const reload = useCallback(async () => { setMeta(await get<Meta>('/meta')); }, []);
  useEffect(() => { reload().catch(() => undefined); }, [reload]);
  if (!meta) return <>{fallback}</>;
  return <MetaCtx.Provider value={{ meta, reload }}>{children}</MetaCtx.Provider>;
}
export function useMeta() {
  const c = useContext(MetaCtx);
  if (!c) throw new Error('useMeta outside provider');
  return c;
}
export function useCan() {
  const { meta } = useMeta();
  return (module: string, action = 'view') => meta.user.is_admin || !!meta.user.permissions?.[module]?.[action];
}
