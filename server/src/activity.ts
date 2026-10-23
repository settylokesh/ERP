import { db, json, type Row } from './db.js';
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

export function queueEmail(to: string, subject: string, body: string, entity?: string, entityId?: number) {
  return db().insert('email_outbox', { to_addr: to, subject, body, entity: entity ?? null, entity_id: entityId ?? null, status: 'sent' });
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
          const payload = JSON.stringify({ rule: rule.name, module, trigger, record: rec });
          fetch(a.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
            .then((r) => db().insert('workflow_log', { rule_id: rule.id, entity: module, entity_id: rec.id, result: `webhook ${r.status}` }))
            .catch((e) => {
              try { db().insert('workflow_log', { rule_id: rule.id, entity: module, entity_id: rec.id, result: `webhook failed: ${e.message}` }); } catch { /* db closed */ }
            });
          results.push('webhook dispatched');
        }
      } catch (e: any) {
        results.push(`error: ${e.message}`);
      }
    }
    d.insert('workflow_log', { rule_id: rule.id, entity: module, entity_id: rec.id ?? null, result: results.join('; ') || 'no actions' });
  }
}
