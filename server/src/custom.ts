import { audit, runWorkflows } from './activity.js';
import type { AuthUser } from './auth.js';
import { db, fail, json, type Row } from './db.js';

const FIELD_TYPES = ['text', 'textarea', 'number', 'decimal', 'currency', 'date', 'checkbox', 'dropdown', 'email', 'phone', 'url', 'lookup_customer', 'lookup_vendor', 'lookup_item'];

function validateFields(fields: Row[]) {
  if (!Array.isArray(fields) || !fields.length) fail('Add at least one field', 422);
  const keys = new Set<string>();
  for (const f of fields) {
    const key = String(f.key ?? '').trim();
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) fail(`Field key "${key}" must be lowercase letters, numbers or underscores`, 422);
    if (keys.has(key)) fail(`Duplicate field key ${key}`, 422);
    keys.add(key);
    if (!String(f.label ?? '').trim()) fail('Every field needs a label', 422);
    if (!FIELD_TYPES.includes(f.type)) fail(`Unsupported field type ${f.type}`, 422);
    if (f.type === 'dropdown' && (!Array.isArray(f.options) || !f.options.length)) fail(`Dropdown "${f.label}" needs options`, 422);
  }
}

export function saveCustomModule(input: Row, user?: AuthUser, id?: number) {
  const d = db();
  const key = String(input.key ?? '').trim();
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(key)) fail('Module key must be lowercase letters, numbers or underscores', 422);
  if (d.get('SELECT 1 FROM custom_modules WHERE key = ? AND id <> ?', key, id ?? -1)) fail('A module with this key already exists', 409);
  validateFields(input.fields);
  const row = { key, name: String(input.name ?? '').trim() || fail('Module name is required', 422), plural: String(input.plural ?? input.name).trim(), prefix: String(input.prefix ?? 'REC-'), fields: JSON.stringify(input.fields) };
  const mid = id ? (d.update('custom_modules', id, row), id) : d.insert('custom_modules', row);
  audit('custom_module', mid, id ? 'updated' : 'created', `Custom module ${row.name}`, user);
  return mid;
}

export const listCustomModules = () => db().all<Row>('SELECT * FROM custom_modules ORDER BY name').map((m) => ({ ...m, fields: json(m.fields, []) }));
export function moduleByKey(key: string) {
  const m = db().get<Row>('SELECT * FROM custom_modules WHERE key = ?', key) ?? fail('Custom module not found', 404);
  return { ...m, fields: json<Row[]>(m.fields, []) };
}

function cleanRecord(fields: Row[], data: Row) {
  const out: Row = {};
  for (const f of fields) {
    let v = data?.[f.key];
    if (v === '' || v === undefined) v = null;
    if (v == null) {
      if (f.required) fail(`${f.label} is required`, 422);
      out[f.key] = null;
      continue;
    }
    switch (f.type) {
      case 'number': case 'decimal': case 'currency':
        if (!Number.isFinite(Number(v))) fail(`${f.label} must be a number`, 422);
        v = Number(v);
        break;
      case 'checkbox': v = !!v; break;
      case 'date': if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) fail(`${f.label} must be a date`, 422); break;
      case 'email': if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) fail(`${f.label} must be an email address`, 422); break;
      case 'dropdown': if (!f.options.includes(v)) fail(`${f.label} must be one of ${f.options.join(', ')}`, 422); break;
      case 'lookup_customer': case 'lookup_vendor':
        if (!db().get('SELECT 1 FROM contacts WHERE id = ? AND kind = ?', v, f.type === 'lookup_customer' ? 'customer' : 'vendor')) fail(`${f.label} not found`, 422);
        v = Number(v);
        break;
      case 'lookup_item': if (!db().get('SELECT 1 FROM items WHERE id = ?', v)) fail(`${f.label} not found`, 422); v = Number(v); break;
      default: v = String(v);
    }
    out[f.key] = v;
  }
  return out;
}

export function saveCustomRecord(key: string, data: Row, user?: AuthUser, id?: number) {
  const d = db();
  const m = moduleByKey(key);
  const clean = cleanRecord(m.fields, data);
  let rid = id;
  if (id) {
    d.get('SELECT 1 FROM custom_records WHERE id = ? AND module_id = ?', id, m.id) ?? fail('Record not found', 404);
    d.update('custom_records', id, { data: JSON.stringify(clean), updated_at: new Date().toISOString() });
  } else {
    const n = (d.value<number>('SELECT COUNT(*) FROM custom_records WHERE module_id = ?', m.id) ?? 0) + 1;
    rid = d.insert('custom_records', { module_id: m.id, number: `${m.prefix}${String(n).padStart(5, '0')}`, data: JSON.stringify(clean), created_by: user?.id ?? null });
  }
  runWorkflows(`custom:${key}`, id ? 'on_update' : 'on_create', { id: rid, ...clean, custom: '{}' }, user, 'custom_records');
  audit(`custom:${key}`, rid!, id ? 'updated' : 'created', `${m.name} record saved`, user);
  return rid!;
}

export function listCustomRecords(key: string, q: Row) {
  const m = moduleByKey(key);
  let rows = db().all<Row>('SELECT r.*, u.name AS created_by_name FROM custom_records r LEFT JOIN users u ON u.id = r.created_by WHERE r.module_id = ? ORDER BY r.id DESC', m.id)
    .map((r) => ({ ...r, data: json(r.data, {}) }));
  if (q.search) {
    const s = String(q.search).toLowerCase();
    rows = rows.filter((r) => r.number?.toLowerCase().includes(s) || Object.values(r.data).some((v) => String(v ?? '').toLowerCase().includes(s)));
  }
  return { module: m, rows };
}

export function deleteCustomRecord(key: string, id: number, user?: AuthUser) {
  const m = moduleByKey(key);
  db().run('DELETE FROM custom_records WHERE id = ? AND module_id = ?', id, m.id);
  audit(`custom:${key}`, id, 'deleted', `${m.name} record deleted`, user);
}

export function saveCustomField(input: Row, id?: number) {
  const module = String(input.module ?? '');
  if (!module) fail('Module is required', 422);
  validateFields([{ ...input, key: input.key }]);
  const row = { module, key: input.key, label: input.label, type: input.type, options: JSON.stringify(input.options ?? []), required: input.required ? 1 : 0, sort: Number(input.sort ?? 0) };
  if (db().get('SELECT 1 FROM custom_fields WHERE module = ? AND key = ? AND id <> ?', module, input.key, id ?? -1)) fail('Field key already exists for this module', 409);
  if (id) { db().update('custom_fields', id, row); return id; }
  return db().insert('custom_fields', row);
}

export function saveWorkflow(input: Row, id?: number) {
  const name = String(input.name ?? '').trim() || fail('Rule name is required', 422);
  if (!input.module) fail('Module is required', 422);
  if (!['on_create', 'on_update', 'on_create_or_update', 'on_status_change'].includes(input.trigger)) fail('Invalid trigger', 422);
  const actions: Row[] = input.actions ?? [];
  if (!actions.length) fail('Add at least one action', 422);
  for (const a of actions) {
    if (!['notify', 'email', 'field_update', 'webhook'].includes(a.type)) fail(`Unknown action ${a.type}`, 422);
    if (a.type === 'webhook' && !/^https?:\/\//.test(a.url ?? '')) fail('Webhook URL must start with http(s)://', 422);
  }
  const row = { name, module: input.module, trigger: input.trigger, conditions: JSON.stringify(input.conditions ?? []), actions: JSON.stringify(actions), is_active: input.is_active === false ? 0 : 1 };
  if (id) { db().update('workflow_rules', id, row); return id; }
  return db().insert('workflow_rules', row);
}
