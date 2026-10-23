const TOKEN_KEY = 'saral.token';

export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
};
export const setToken = (t: string) => {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
};

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: boolean; text?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken()}` };
  let body: BodyInit | undefined;
  if (opts.text !== undefined) { headers['content-type'] = 'text/csv'; body = opts.text; }
  else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const res = await fetch(`/api${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  if (res.status === 401 && !path.startsWith('/auth/login')) onUnauthorized?.();
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  if (opts.raw) return res as unknown as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body: unknown = {}) => api<T>(p, { method: 'POST', body });
export const put = <T = any>(p: string, body: unknown = {}) => api<T>(p, { method: 'PUT', body });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

export const qs = (o: Record<string, unknown>) => {
  const s = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  return s ? `?${s}` : '';
};

/** Downloads a file (CSV/JSON) with the session token in the header, never in the URL. */
export async function download(path: string, fallbackName = 'export') {
  const res = await api<Response>(path, { raw: true });
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^"]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
