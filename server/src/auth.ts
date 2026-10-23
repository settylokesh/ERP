import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db, fail, json, type Row } from './db.js';

export const MODULES = [
  'items', 'sales', 'purchases', 'inventory', 'manufacturing', 'accountant', 'banking', 'assets',
  'payroll', 'compliance', 'reports', 'settings', 'custom',
] as const;
export type PermModule = (typeof MODULES)[number];
export type PermAction = 'view' | 'create' | 'edit' | 'delete' | 'approve';
export const ACTIONS: PermAction[] = ['view', 'create', 'edit', 'delete', 'approve'];

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role_id: number;
  role_name: string;
  is_admin: boolean;
  /** Set for new accounts, administrator resets and accounts still on a former default password. */
  must_change_password: boolean;
  permissions: Record<string, Partial<Record<PermAction, boolean>>>;
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function full(mods: readonly string[]) {
  return Object.fromEntries(mods.map((m) => [m, { view: true, create: true, edit: true, delete: true, approve: true }]));
}
export function viewOnly(mods: readonly string[]) {
  return Object.fromEntries(mods.map((m) => [m, { view: true }]));
}

export const DEFAULT_ROLES: { name: string; description: string; is_admin?: boolean; permissions: Row }[] = [
  { name: 'Admin', description: 'Unrestricted access to every module and setting', is_admin: true, permissions: full(MODULES) },
  {
    name: 'Accountant', description: 'Accounting, banking, compliance and reports',
    permissions: { ...full(['accountant', 'banking', 'assets', 'compliance', 'sales', 'purchases']), ...viewOnly(['items', 'inventory', 'payroll', 'reports', 'manufacturing']) },
  },
  {
    name: 'Sales Executive', description: 'Customers, quotes, sales orders and invoices',
    permissions: { sales: { view: true, create: true, edit: true }, ...viewOnly(['items', 'inventory', 'reports']) },
  },
  {
    name: 'Purchase Officer', description: 'Vendors, purchase requests, RFQs, POs and bills',
    permissions: { purchases: { view: true, create: true, edit: true, delete: true }, ...viewOnly(['items', 'inventory', 'reports']) },
  },
  {
    name: 'Warehouse Manager', description: 'Items, stock movements, packages and receives',
    permissions: { ...full(['items', 'inventory']), sales: { view: true, create: true, edit: true }, purchases: { view: true, create: true, edit: true }, ...viewOnly(['reports']) },
  },
  {
    name: 'Production Manager', description: 'BOMs, manufacturing orders, job cards and quality',
    permissions: { ...full(['manufacturing']), inventory: { view: true, create: true, edit: true }, ...viewOnly(['items', 'reports', 'sales']) },
  },
  { name: 'HR Manager', description: 'Employees and payroll', permissions: { ...full(['payroll']), ...viewOnly(['reports']) } },
];

export function loadUser(userId: number): AuthUser | null {
  const u = db().get<Row>(
    `SELECT u.id, u.name, u.email, u.role_id, u.is_active, u.must_change_password, r.name AS role_name, r.is_admin, r.permissions
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, userId);
  if (!u || !u.is_active) return null;
  return {
    id: u.id, name: u.name, email: u.email, role_id: u.role_id, role_name: u.role_name, is_admin: !!u.is_admin,
    must_change_password: !!u.must_change_password, permissions: json(u.permissions, {}),
  };
}

export function can(user: AuthUser | undefined, module: PermModule | string, action: PermAction = 'view'): boolean {
  if (!user) return false;
  if (user.is_admin) return true;
  return !!user.permissions?.[module]?.[action];
}
export function assertCan(user: AuthUser | undefined, module: PermModule | string, action: PermAction = 'view') {
  if (!can(user, module, action)) fail(`You do not have permission to ${action} ${module}`, 403);
}
/** Passes when the user may view at least one of the modules (for lookups shared by several modules). */
export function assertCanAny(user: AuthUser | undefined, modules: (PermModule | string)[]) {
  if (!modules.some((m) => can(user, m, 'view'))) fail(`You do not have permission to view ${modules.join(' or ')}`, 403);
}

// ---------- Sign-in throttling ----------
// Three counters guard sign-in, each over a 15-minute window:
//   * per (email, client IP)  - 8 failures: stops guessing from one address without locking the user out elsewhere;
//   * per email               - 30 failures from any addresses: stops distributed guessing against one account;
//   * per client IP           - 100 failures for any emails: stops one address spraying many accounts.
// The per-IP block is skipped for an (email, IP) pair that signed in successfully in the last 30 days, so many users
// behind one shared address (office NAT, or a proxy without TRUST_PROXY) are not all locked out by one attacker there.
// Entries expire after the window. The maps are bounded; when full, expired and then unblocked entries are evicted
// before blocked ones, so flooding cannot clear an active block.
const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { pair: 8, email: 30, ip: 100, passwordChange: 8 } as const;
const TRUST_MS = 30 * 86400000;
const MAX_TRACKED = 50_000;
const failures = new Map<string, { count: number; first: number; limit: number }>();
const trustedPairs = new Map<string, number>();

function throttleKeys(email: string, ip: string): [string, number][] {
  const e = email.slice(0, 254), i = ip.slice(0, 64);
  return [[`p:${e}|${i}`, LIMITS.pair], [`e:${e}`, LIMITS.email], [`i:${i}`, LIMITS.ip]];
}
const blocked = (f: { count: number; first: number; limit: number } | undefined, now: number) => !!f && now - f.first <= WINDOW_MS && f.count >= f.limit;
function pruneFailures(now: number) {
  for (const [k, f] of failures) if (now - f.first > WINDOW_MS) failures.delete(k);
  for (const [k, f] of failures) {
    if (failures.size <= MAX_TRACKED) return;
    if (!blocked(f, now)) failures.delete(k);
  }
  for (const k of failures.keys()) {
    if (failures.size <= MAX_TRACKED) return;
    failures.delete(k);
  }
}
function recordFailure(keys: [string, number][], now: number) {
  for (const [key, limit] of keys) {
    const f = failures.get(key);
    if (f && now - f.first <= WINDOW_MS) f.count++;
    else failures.set(key, { count: 1, first: now, limit });
  }
  if (failures.size > MAX_TRACKED) pruneFailures(now);
}
function trustPair(key: string, now: number) {
  trustedPairs.delete(key);
  trustedPairs.set(key, now + TRUST_MS);
  for (const k of trustedPairs.keys()) {
    if (trustedPairs.size <= MAX_TRACKED) break;
    trustedPairs.delete(k);
  }
}
const isTrusted = (key: string, now: number) => (trustedPairs.get(key) ?? 0) > now;
const retryMessage = (what: string, f: { first: number }, now: number) => {
  const minutes = Math.ceil((WINDOW_MS - (now - f.first)) / 60000);
  return `Too many failed ${what}. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
};
/** Clears throttling state (used by tests). */
export function resetLoginThrottle() {
  failures.clear();
  trustedPairs.clear();
}

// Verifying against a throw-away hash when the email is unknown keeps response times the same, so sign-in does not reveal
// which email addresses have accounts.
let dummyHash: string | null = null;
const timingDummy = () => (dummyHash ??= hashPassword(randomBytes(12).toString('hex')));

const SESSION_DAYS = 7;

export function login(email: string, password: string, ip = '') {
  const key = String(email ?? '').trim().toLowerCase();
  if (!key || key.length > 254) fail('Invalid email or password', 401);
  const now = Date.now();
  const keys = throttleKeys(key, ip);
  const checked = isTrusted(keys[0][0], now) ? keys.slice(0, 2) : keys;
  const hit = checked.map(([k]) => failures.get(k)).find((f) => blocked(f, now));
  if (hit) fail(retryMessage('sign-in attempts', hit, now), 429);
  const u = db().get<Row>('SELECT * FROM users WHERE email = ?', key);
  const ok = verifyPassword(String(password ?? ''), u?.password_hash ?? timingDummy());
  if (!u || !u.is_active || !ok) {
    recordFailure(keys, now);
    fail('Invalid email or password', 401);
  }
  failures.delete(keys[0][0]);
  failures.delete(keys[1][0]);
  trustPair(keys[0][0], now);
  db().run('DELETE FROM sessions WHERE expires_at < ?', new Date(now).toISOString());
  const token = randomBytes(32).toString('hex');
  const expires = new Date(now + SESSION_DAYS * 86400000).toISOString();
  db().insert('sessions', { token, user_id: u!.id, expires_at: expires });
  db().update('users', u!.id, { last_login_at: new Date(now).toISOString() });
  return { token, user: loadUser(u!.id) };
}
export function logout(token: string) {
  db().run('DELETE FROM sessions WHERE token = ?', token);
}

/**
 * Changes the signed-in user's password after checking the current one, and signs out their other sessions.
 * Wrong current passwords are throttled like sign-in, so a stolen session cannot be used to guess the password.
 */
export function changePassword(userId: number, current: string, next: string, keepToken: string) {
  const u = db().get<Row>('SELECT * FROM users WHERE id = ?', userId) ?? fail('User not found', 404);
  const now = Date.now();
  const key = `c:${userId}`;
  const f = failures.get(key);
  if (blocked(f, now)) fail(retryMessage('password attempts', f!, now), 429);
  if (!verifyPassword(String(current ?? ''), u.password_hash)) {
    recordFailure([[key, LIMITS.passwordChange]], now);
    fail('Current password is incorrect', 422);
  }
  failures.delete(key);
  assertPasswordStrength(next);
  if (String(next) === String(current)) fail('Choose a password different from the current one', 422);
  db().update('users', userId, { password_hash: hashPassword(String(next)), must_change_password: 0 });
  db().run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', userId, keepToken);
}

export function assertPasswordStrength(pw: unknown) {
  const s = String(pw ?? '');
  if (s.length < 8) fail('Password must be at least 8 characters', 422);
  if (s.length > 200) fail('Password is too long', 422);
}

/** Removes expired sessions. Runs on sign-in and periodically from the server process. */
export function purgeExpiredSessions() {
  return Number(db().run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString()).changes);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      token?: string;
    }
  }
}

const PASSWORD_CHANGE_PATHS = new Set(['/auth/password', '/auth/me', '/auth/logout', '/meta']);

/** Former built-in credentials. Accounts still using one must change it at next sign-in (see migration 2). */
export const RETIRED_DEFAULT_PASSWORDS = ['admin123', 'demo1234'];

export function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  // Tokens are only accepted in the Authorization header, never in URLs (which leak into logs and history).
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return next(fail('Not signed in', 401));
  const s = db().get<Row>('SELECT * FROM sessions WHERE token = ?', token);
  if (!s || s.expires_at < new Date().toISOString()) return next(fail('Session expired. Please sign in again.', 401));
  const user = loadUser(s.user_id);
  if (!user) return next(fail('User is inactive', 401));
  req.user = user;
  req.token = token;
  // Until a required password change is done, only the endpoints needed to make it are available.
  if (user.must_change_password && !PASSWORD_CHANGE_PATHS.has(req.path)) return next(fail('Change your password to continue', 403, { code: 'password_change_required' }));
  next();
}
