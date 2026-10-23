import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { createTransport, type Transporter } from 'nodemailer';
import { db, json, type Row } from './db.js';
import { onWorkers } from './runtime.js';
import type { AuthUser } from './auth.js';

export function audit(entity: string, entityId: number | null, action: string, summary: string, user?: AuthUser | null, data?: unknown) {
  db().insert('audit_log', {
    entity, entity_id: entityId, action, summary, user_id: user?.id ?? null, data: data === undefined ? null : JSON.stringify(data),
  });
}

export function history(entity: string, entityId: number) {
  return db().all(
    `SELECT a.at, a.action, a.summary, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.entity = ? AND a.entity_id = ? ORDER BY a.id DESC`, entity, entityId);
}

export function notify(userIds: number[], title: string, body = '', link = '') {
  for (const id of new Set(userIds)) db().insert('notifications', { user_id: id, title, body, link });
}
export function usersInRoles(roleIds: number[]): number[] {
  if (!roleIds.length) return [];
  return db().all<{ id: number }>(`SELECT id FROM users WHERE is_active = 1 AND role_id IN (${roleIds.map(() => '?').join(',')})`, ...roleIds).map((r) => r.id);
}
export function adminUsers(): number[] {
  return db().all<{ id: number }>('SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.is_admin = 1 AND u.is_active = 1').map((r) => r.id);
}

// ---------- Email ----------
// Every email is written to the outbox first. When SMTP is configured (SMTP_HOST and friends) it is delivered after the
// current request's transaction has finished, and the outbox row records 'sent' or 'failed'. Without SMTP it stays
// 'queued' so nothing pretends to have been sent.

let transport: Transporter | null | undefined;
function mailer(): Transporter | null {
  if (transport !== undefined) return transport;
  const host = process.env.SMTP_HOST;
  transport = host
    ? createTransport({
      host, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === '1' || process.env.SMTP_PORT === '465',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
    })
    : null;
  return transport;
}
export const emailConfigured = () => !!process.env.SMTP_HOST;

async function deliver(id: number) {
  const t = mailer();
  if (!t) return;
  let row: Row | undefined;
  try {
    // Claim the row first: only one delivery attempt can move it from 'queued' to 'sending'.
    if (Number(db().run("UPDATE email_outbox SET status = 'sending' WHERE id = ? AND status = 'queued'", id).changes) !== 1) return;
    row = db().get<Row>('SELECT * FROM email_outbox WHERE id = ?', id);
  } catch { return; }
  if (!row) return;
  try {
    await t.sendMail({ from: process.env.SMTP_FROM ?? process.env.SMTP_USER, to: row.to_addr, subject: row.subject, text: row.body ?? '' });
    db().update('email_outbox', id, { status: 'sent', sent_at: new Date().toISOString(), error: null });
  } catch (e: any) {
    try { db().update('email_outbox', id, { status: 'failed', error: String(e?.message ?? e).slice(0, 500) }); } catch { /* database closed */ }
  }
}

export function queueEmail(to: string, subject: string, body: string, entity?: string, entityId?: number) {
  const id = db().insert('email_outbox', { to_addr: to, subject, body, entity: entity ?? null, entity_id: entityId ?? null, status: 'queued' });
  if (mailer()) setImmediate(() => void deliver(id));
  return id;
}

/** Re-sends failed or still-queued emails (e.g. after SMTP is configured). Rows being sent right now are skipped. */
export function retryEmails(ids?: number[]) {
  if (!mailer()) return 0;
  const list = (ids ?? []).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  const rows = db().all<{ id: number }>(`SELECT id FROM email_outbox WHERE status IN ('queued','failed') ${list.length ? `AND id IN (${list.map(() => '?').join(',')})` : ''} ORDER BY id LIMIT 200`, ...list);
  for (const r of rows) {
    db().update('email_outbox', r.id, { status: 'queued' });
    setImmediate(() => void deliver(r.id));
  }
  return rows.length;
}

const interpolate = (tpl: string, rec: Row) => String(tpl ?? '').replace(/\$\{(\w+)\}/g, (_, k) => (rec[k] ?? '').toString());

function check(rec: Row, c: { field: string; op: string; value?: any }): boolean {
  const v = c.field.startsWith('custom.') ? json<Row>(rec.custom, {})[c.field.slice(7)] : rec[c.field];
  const n = Number(v), cv = Number(c.value);
  switch (c.op) {
    case 'eq': return String(v ?? '') === String(c.value ?? '');
    case 'neq': return String(v ?? '') !== String(c.value ?? '');
    case 'gt': return n > cv;
    case 'gte': return n >= cv;
    case 'lt': return n < cv;
    case 'lte': return n <= cv;
    case 'contains': return String(v ?? '').toLowerCase().includes(String(c.value ?? '').toLowerCase());
    case 'empty': return v == null || v === '';
    case 'not_empty': return !(v == null || v === '');
    default: return false;
  }
}

const UPDATABLE = new Set(['reference', 'salesperson', 'notes', 'terms']);

/** Expands an IPv6 address (optionally ending in dotted IPv4) to its eight 16-bit groups, or null if malformed. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip;
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const p = dotted.slice(1).map(Number);
    if (p.some((x) => x > 255)) return null;
    s = `${s.slice(0, -dotted[0].length)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return groups.length === 8 && groups.every((g) => g >= 0) ? groups : null;
}

/**
 * True for addresses a webhook must not reach: loopback, private (RFC 1918 / unique-local), link-local, CGNAT,
 * benchmarking, multicast, unspecified, and IPv6 forms that carry such an IPv4 address (IPv4-mapped, IPv4-compatible,
 * NAT64 64:ff9b::/96, 6to4 2002::/16). Teredo and local-use NAT64 are refused outright. Malformed input counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/%.*$/, '');
  if (v.includes(':')) {
    const g = ipv6Groups(v);
    if (!g) return true;
    const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    if (g.slice(0, 6).every((x) => x === 0)) return g[6] === 0 || isPrivateAddress(v4(g[6], g[7])); // ::, ::1, ::a.b.c.d
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateAddress(v4(g[6], g[7])); // ::ffff:a.b.c.d
    if (g[0] === 0x64 && g[1] === 0xff9b) return g.slice(2, 6).some((x) => x !== 0) || isPrivateAddress(v4(g[6], g[7]));
    if (g[0] === 0x2002) return isPrivateAddress(v4(g[1], g[2]));
    if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo tunnels to arbitrary IPv4 hosts
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00
      || (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0);
  }
  const p = v.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168) || (p[0] === 192 && p[1] === 0 && p[2] === 0) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
    || (p[0] === 198 && (p[1] === 18 || p[1] === 19)) || p[0] >= 224;
}

const PRIVATE_TARGET = 'target resolves to a private or local address';

/** DNS lookup used for webhook connections: refuses private results, so the address checked is the address connected to. */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as unknown as LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) return callback(new Error(PRIVATE_TARGET), '', 0);
    if (options.all) return (callback as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

/**
 * Posts a webhook and resolves with the HTTP status. Webhooks may only call public addresses, so a workflow rule cannot
 * be used to reach services inside the network (cloud metadata endpoints, databases, admin consoles). The check runs in
 * the connection's own DNS lookup, so a hostname cannot pass the check and then re-resolve to an internal address.
 * Redirects are not followed. Set WEBHOOK_ALLOW_PRIVATE=1 to allow internal targets.
 */
export function postWebhook(url: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('only http(s) URLs are allowed'));
    const allowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE === '1';
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && isIP(host) && isPrivateAddress(host)) return reject(new Error(PRIVATE_TARGET));
    const headers = { 'content-type': 'application/json', 'user-agent': 'SaralERP-Webhook/1.0' };
    if (onWorkers) {
      // On Cloudflare, outbound requests leave through Cloudflare's network, which cannot reach private networks.
      return fetch(u, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) })
        .then((r) => { void r.body?.cancel(); resolve(r.status); }, reject);
    }
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(u, {
      method: 'POST',
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      lookup: allowPrivate ? undefined : publicOnlyLookup,
      signal: AbortSignal.timeout(10_000),
    }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function logWebhook(ruleId: number, module: string, entityId: number | null, result: string) {
  try { db().insert('workflow_log', { rule_id: ruleId, entity: module, entity_id: entityId, result }); } catch { /* database closed */ }
}

/** Evaluates active workflow rules for a module after a record changes. */
export function runWorkflows(module: string, trigger: 'on_create' | 'on_update' | 'on_status_change', rec: Row, user?: AuthUser | null, table = 'documents') {
  const d = db();
  const rules = d.all<Row>(
    `SELECT * FROM workflow_rules WHERE is_active = 1 AND module = ? AND (trigger = ? OR (trigger = 'on_create_or_update' AND ? IN ('on_create','on_update')))`,
    module, trigger, trigger);
  for (const rule of rules) {
    const conditions = json<any[]>(rule.conditions, []);
    if (!conditions.every((c) => check(rec, c))) continue;
    const results: string[] = [];
    for (const a of json<any[]>(rule.actions, [])) {
      try {
        if (a.type === 'notify') {
          let ids: number[] = [];
          if (a.to === 'creator' && (rec.created_by || user?.id)) ids = [rec.created_by ?? user!.id];
          else if (String(a.to).startsWith('role:')) ids = usersInRoles([Number(String(a.to).slice(5))]);
          else if (String(a.to).startsWith('user:')) ids = [Number(String(a.to).slice(5))];
          else ids = adminUsers();
          notify(ids, interpolate(a.title || rule.name, rec), interpolate(a.body ?? '', rec), rec.link ?? '');
          results.push(`notified ${ids.length} user(s)`);
        } else if (a.type === 'email') {
          const to = a.to === 'contact' ? rec.contact_email : a.to;
          if (to) {
            queueEmail(to, interpolate(a.subject || rule.name, rec), interpolate(a.body ?? '', rec), module, rec.id);
            results.push(`emailed ${to}`);
          }
        } else if (a.type === 'field_update' && rec.id) {
          if (String(a.field).startsWith('custom.')) {
            const custom = { ...json<Row>(rec.custom, {}), [String(a.field).slice(7)]: interpolate(a.value, rec) };
            d.run(`UPDATE ${table} SET custom = ? WHERE id = ?`, JSON.stringify(custom), rec.id);
          } else if (UPDATABLE.has(a.field) && table === 'documents') {
            d.run(`UPDATE documents SET ${a.field} = ? WHERE id = ?`, interpolate(a.value, rec), rec.id);
          }
          results.push(`updated ${a.field}`);
        } else if (a.type === 'webhook' && a.url) {
          // Sent after the change commits, without blocking the request; the outcome is written to the workflow log.
          const payload = JSON.stringify({ rule: rule.name, module, trigger, record: rec, sent_at: new Date().toISOString() });
          const url = String(a.url);
          postWebhook(url, payload)
            .then((status) => logWebhook(rule.id, module, rec.id ?? null, `webhook ${status}`))
            .catch((e) => logWebhook(rule.id, module, rec.id ?? null, `webhook failed: ${e?.message ?? e}`));
          results.push('webhook dispatched');
        }
      } catch (e: any) {
        results.push(`error: ${e.message}`);
      }
    }
    d.insert('workflow_log', { rule_id: rule.id, entity: module, entity_id: rec.id ?? null, result: results.join('; ') || 'no actions' });
  }
}
