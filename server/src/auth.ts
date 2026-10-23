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
    `SELECT u.id, u.name, u.email, u.role_id, u.is_active, r.name AS role_name, r.is_admin, r.permissions
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, userId);
  if (!u || !u.is_active) return null;
  return { id: u.id, name: u.name, email: u.email, role_id: u.role_id, role_name: u.role_name, is_admin: !!u.is_admin, permissions: json(u.permissions, {}) };
}

export function can(user: AuthUser | undefined, module: PermModule | string, action: PermAction = 'view'): boolean {
  if (!user) return false;
  if (user.is_admin) return true;
  return !!user.permissions?.[module]?.[action];
}
export function assertCan(user: AuthUser | undefined, module: PermModule | string, action: PermAction = 'view') {
  if (!can(user, module, action)) fail(`You do not have permission to ${action} ${module}`, 403);
}

export function login(email: string, password: string) {
  const u = db().get<Row>('SELECT * FROM users WHERE email = ?', String(email ?? '').trim());
  if (!u || !u.is_active || !verifyPassword(String(password ?? ''), u.password_hash)) fail('Invalid email or password', 401);
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  db().insert('sessions', { token, user_id: u!.id, expires_at: expires });
  return { token, user: loadUser(u!.id) };
}
export function logout(token: string) {
  db().run('DELETE FROM sessions WHERE token = ?', token);
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

export function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) return next(fail('Not signed in', 401));
  const s = db().get<Row>('SELECT * FROM sessions WHERE token = ?', token);
  if (!s || s.expires_at < new Date().toISOString()) return next(fail('Session expired. Please sign in again.', 401));
  const user = loadUser(s.user_id);
  if (!user) return next(fail('User is inactive', 401));
  req.user = user;
  req.token = token;
  next();
}
