import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db.js';
import { LATEST_VERSION, migrate, schemaVersion } from '../src/migrations.js';
import { hashPassword } from '../src/auth.js';
import { initDatabase, setupToken } from '../src/seed.js';
import { org } from '../src/settings.js';

const app = createApp();

beforeAll(() => {
  initDatabase(':memory:');
});

describe('First-run setup', () => {
  it('starts with no users, no business data and no demo content', () => {
    expect(db().value('SELECT COUNT(*) FROM users')).toBe(0);
    for (const t of ['contacts', 'items', 'documents', 'journals', 'employees', 'departments', 'designations', 'payments']) {
      expect(db().value(`SELECT COUNT(*) FROM ${t}`), t).toBe(0);
    }
    expect(db().all('SELECT code FROM currencies')).toEqual([{ code: 'INR' }]);
    expect(org()).toMatchObject({ name: '', setup_complete: false, invoice_terms: '', invoice_notes: '' });
  });

  it('reports that setup is needed and refuses sign-in', async () => {
    expect((await request(app).get('/api/setup')).body.needs_setup).toBe(true);
    expect((await request(app).post('/api/auth/login').send({ email: 'admin@saral.local', password: 'admin123' })).status).toBe(401);
  });

  it('requires the one-time setup code from the server log', async () => {
    const body = { organisation: { name: 'Acme', state_code: '29' }, admin: { name: 'A', email: 'a@example.com', password: 'long-enough-1' } };
    expect((await request(app).post('/api/setup').send(body)).status).toBe(403);
    expect((await request(app).post('/api/setup').send({ ...body, setup_code: 'WRONG-CODE-0000' })).status).toBe(403);
    expect(setupToken()).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(db().value('SELECT COUNT(*) FROM users')).toBe(0);
  });

  it('validates the organisation and administrator', async () => {
    const code = setupToken();
    const bad = await request(app).post('/api/setup').send({ setup_code: code, organisation: { name: 'Acme', state_code: '29', gstin: '27AAPFU0939F1ZV' }, admin: { name: 'A', email: 'a@example.com', password: 'long-enough-1' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/state code does not match/);
    const weak = await request(app).post('/api/setup').send({ setup_code: code, organisation: { name: 'Acme', state_code: '29' }, admin: { name: 'A', email: 'a@example.com', password: 'short' } });
    expect(weak.status).toBe(422);
    const pin = await request(app).post('/api/setup').send({ setup_code: code, organisation: { name: 'Acme', state_code: '29', pincode: '5600' }, admin: { name: 'A', email: 'a@example.com', password: 'long-enough-1' } });
    expect(pin.status).toBe(422);
    expect(pin.body.error).toMatch(/PIN code/);
    expect(weak.status).toBe(422);
    expect(db().value('SELECT COUNT(*) FROM users')).toBe(0);
  });

  it('creates the organisation and the first administrator, then signs in', async () => {
    const r = await request(app).post('/api/setup').send({
      setup_code: setupToken().toLowerCase(),
      organisation: { name: 'Acme Industries', state_code: '27', gstin: '27AAPFU0939F1ZV', city: 'Pune', pincode: '411001', fiscal_year_start_month: 4 },
      admin: { name: 'Owner', email: 'Owner@Acme.example', password: 'owner-pass-123' },
    });
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.user).toMatchObject({ email: 'owner@acme.example', is_admin: true });
    expect(org()).toMatchObject({ name: 'Acme Industries', legal_name: 'Acme Industries', state_code: '27', pan: 'AAPFU0939F', setup_complete: true });
    expect(org().inventory_start_date).toMatch(/^\d{4}-04-01$/);
    expect(db().value('SELECT state_code FROM warehouses WHERE is_primary = 1')).toBe('27');
    expect((await request(app).get('/api/setup')).body.needs_setup).toBe(false);
  });
});

describe('Schema migrations', () => {
  it('records the latest schema version and is idempotent', () => {
    expect(schemaVersion(db())).toBe(LATEST_VERSION);
    expect(migrate(db())).toEqual([]);
  });

  it('upgrades a database created by an older version', () => {
    const d = db();
    // Simulate an old database: drop a column added by migration 1 and reset the version.
    d.raw.exec('ALTER TABLE users DROP COLUMN last_login_at');
    d.raw.exec('PRAGMA user_version = 0');
    expect(migrate(d)).toEqual([1, 2]);
    expect(d.all<{ name: string }>('PRAGMA table_info(users)').some((c) => c.name === 'last_login_at')).toBe(true);
  });

  it('forces a password change for accounts still using a former default password', async () => {
    const d = db();
    const role = d.value<number>('SELECT id FROM roles WHERE is_admin = 1');
    d.insert('users', { name: 'Old admin', email: 'legacy@example.com', password_hash: hashPassword('admin123'), role_id: role });
    d.raw.exec('PRAGMA user_version = 1');
    expect(migrate(d)).toEqual([2]);
    expect(d.value('SELECT must_change_password FROM users WHERE email = ?', 'legacy@example.com')).toBe(1);
    expect(d.value('SELECT must_change_password FROM users WHERE email = ?', 'owner@acme.example')).toBe(0);
    const login = await request(app).post('/api/auth/login').send({ email: 'legacy@example.com', password: 'admin123' });
    const auth = { Authorization: `Bearer ${login.body.token}` };
    expect(login.body.user.must_change_password).toBe(true);
    const blocked = await request(app).get('/api/dashboard').set(auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.details).toEqual({ code: 'password_change_required' });
    expect((await request(app).get('/api/meta').set(auth)).status).toBe(200);
    expect((await request(app).post('/api/auth/password').set(auth).send({ current: 'admin123', next: 'admin123' })).status).toBe(422);
    expect((await request(app).post('/api/auth/password').set(auth).send({ current: 'admin123', next: 'a-new-pass-99' })).status).toBe(200);
    expect((await request(app).get('/api/dashboard').set(auth)).status).toBe(200);
  });
});
