import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db.js';
import { gstr1, gstr3b } from '../src/gst.js';
import { REPORTS, runReport, toCsv } from '../src/reports.js';
import { resetLoginThrottle } from '../src/auth.js';
import { completeSetup, initDatabase } from '../src/seed.js';
import { today, addDays } from '../src/util.js';
import { loadSampleCompany, SAMPLE_USER_PASSWORD } from './fixtures/sample-company.js';

const app = createApp();
const ADMIN = { name: 'Admin', email: 'admin@example.com', password: 'admin-pass-123' };
let token = '';
let salesToken = '';

beforeAll(async () => {
  initDatabase(':memory:');
  completeSetup({ organisation: { name: 'Sample Company', state_code: '29', inventory_start_date: '2026-04-01' }, admin: ADMIN });
  loadSampleCompany();
  token = (await request(app).post('/api/auth/login').send({ email: ADMIN.email, password: ADMIN.password })).body.token;
  salesToken = (await request(app).post('/api/auth/login').send({ email: 'sales@example.com', password: SAMPLE_USER_PASSWORD })).body.token;
});
const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

describe('Sample company integrity', () => {
  it('keeps every report consistent with the ledger', () => {
    expect(runReport('trial_balance', {}).meta!.balanced).toBe(true);
    expect(runReport('balance_sheet', {}).meta!.balanced).toBe(true);
    expect(runReport('inventory_valuation', {}).meta!.reconciled).toBe(true);
    for (const key of Object.keys(REPORTS)) expect(() => runReport(key, {}), key).not.toThrow();
  });

  it('builds GSTR-1 and GSTR-3B for the current month', () => {
    const period = addDays(today(), -18).slice(0, 7);
    const r1 = gstr1(period);
    expect(r1.json.gstin).toMatch(/^29/);
    const r3 = gstr3b(period);
    expect(r3.table_3_1).toHaveLength(5);
    const liab = r3.liability.forward;
    const paid = r3.setoff.used;
    // everything not covered by credit is payable in cash
    expect(Math.round((liab.igst - paid.igst.igst - paid.cgst.igst - paid.sgst.igst) * 100) / 100).toBe(r3.setoff.cash.igst);
  });
});

describe('API', () => {
  it('rejects unauthenticated requests and bad logins', async () => {
    expect((await request(app).get('/api/dashboard')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: ADMIN.email, password: 'nope' })).status).toBe(401);
  });

  it('serves metadata, dashboard and search', async () => {
    const meta = await request(app).get('/api/meta').set(auth());
    expect(meta.status).toBe(200);
    expect(meta.body.doc_types.invoice.label).toBe('Invoice');
    const dash = await request(app).get('/api/dashboard').set(auth());
    expect(dash.status).toBe(200);
    expect(dash.body.receivables.total).toBeGreaterThan(0);
    const s = await request(app).get('/api/search?q=Mehta').set(auth());
    expect(s.body.some((r: any) => r.label === 'Mehta Engineering Works')).toBe(true);
  });

  it('creates an invoice and records a payment over HTTP', async () => {
    const cust = db().value<number>("SELECT id FROM contacts WHERE name = 'Sri Lakshmi Agro Traders'");
    const item = db().value<number>("SELECT id FROM items WHERE sku = 'SV-INST'");
    const res = await request(app).post('/api/docs/invoice').set(auth()).send({ contact_id: cust, submit: true, lines: [{ item_id: item, qty: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'open', total: 2832 });
    const bank = db().value<number>("SELECT id FROM accounts WHERE name = 'HDFC Bank Current A/c'");
    const p = await request(app).post('/api/payments/received').set(auth()).send({ contact_id: cust, amount: 2832, account_id: bank, allocations: [{ document_id: res.body.id, amount: 2832 }] });
    expect(p.status).toBe(200);
    const after = await request(app).get(`/api/docs/invoice/${res.body.id}`).set(auth());
    expect(after.body.status).toBe('paid');
    expect(after.body.actions.some((a: any) => a.key === 'einvoice_record')).toBe(true);
  });

  it('returns validation errors as 422 with a message', async () => {
    const res = await request(app).post('/api/docs/invoice').set(auth()).send({ lines: [] });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Customer is required/);
  });

  it('throttles repeated failed logins', async () => {
    for (let i = 0; i < 8; i++) await request(app).post('/api/auth/login').send({ email: 'hr@example.com', password: 'wrong' });
    const r = await request(app).post('/api/auth/login').send({ email: 'hr@example.com', password: SAMPLE_USER_PASSWORD });
    expect(r.status).toBe(429);
    // Without TRUST_PROXY a client cannot dodge the limit by sending its own X-Forwarded-For header.
    const spoofed = await request(app).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.9').send({ email: 'hr@example.com', password: SAMPLE_USER_PASSWORD });
    expect(spoofed.status).toBe(429);
  });

  it('does not accept session tokens in the URL', async () => {
    expect((await request(app).get(`/api/dashboard?token=${token}`)).status).toBe(401);
  });

  it('neutralises spreadsheet formulas in CSV exports', () => {
    const csv = toCsv({ title: 'T', columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], rows: [{ a: '=HYPERLINK("x")', b: -12.5 }] });
    expect(csv).toContain(`"'=HYPERLINK(""x"")",-12.5`);
  });

  it('enforces role permissions', async () => {
    expect((await request(app).get('/api/payroll/employees').set(auth(salesToken))).status).toBe(403);
    expect((await request(app).get('/api/docs/invoice').set(auth(salesToken))).status).toBe(200);
    const inv = db().value<number>("SELECT id FROM documents WHERE type = 'invoice' LIMIT 1");
    expect((await request(app).delete(`/api/docs/invoice/${inv}`).set(auth(salesToken))).status).toBe(403);
  });

  it('exports reports as CSV and GSTR-1 as JSON', async () => {
    const csv = await request(app).get('/api/reports/trial_balance.csv').set(auth());
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toMatch(/^Trial Balance/);
    const j = await request(app).get(`/api/gst/gstr1/json?period=${today().slice(0, 7)}`).set(auth());
    expect(j.status).toBe(200);
    expect(j.body).toHaveProperty('fp');
  });

  it('manages custom modules and records', async () => {
    const m = await request(app).post('/api/custom-modules').set(auth()).send({ key: 'machine_log', name: 'Machine Log', plural: 'Machine Logs', fields: [{ key: 'machine', label: 'Machine', type: 'text', required: true }, { key: 'hours', label: 'Hours', type: 'decimal' }, { key: 'shift', label: 'Shift', type: 'dropdown', options: ['A', 'B'] }] });
    expect(m.status).toBe(200);
    expect((await request(app).post('/api/custom/machine_log').set(auth()).send({ hours: 2 })).status).toBe(422);
    expect((await request(app).post('/api/custom/machine_log').set(auth()).send({ machine: 'CNC-1', hours: 7.5, shift: 'C' })).status).toBe(422);
    expect((await request(app).post('/api/custom/machine_log').set(auth()).send({ machine: 'CNC-1', hours: 7.5, shift: 'A' })).status).toBe(200);
    const list = await request(app).get('/api/custom/machine_log').set(auth());
    expect(list.body.rows[0].data).toMatchObject({ machine: 'CNC-1', hours: 7.5 });
  });

  it('runs manufacturing actions through the API', async () => {
    const mo = db().value<number>("SELECT id FROM manufacturing_orders WHERE status = 'confirmed'");
    const r = await request(app).get(`/api/manufacturing/orders/${mo}`).set(auth());
    expect(r.body.job_cards.length).toBe(4);
    const jc = r.body.job_cards[0].id;
    expect((await request(app).post(`/api/manufacturing/job-cards/${jc}/start`).set(auth()).send({})).status).toBe(200);
    expect((await request(app).post(`/api/manufacturing/job-cards/${r.body.job_cards[1].id}/start`).set(auth()).send({})).status).toBe(422);
  });

  it('closes first-run setup once an administrator exists', async () => {
    const st = await request(app).get('/api/setup');
    expect(st.body.needs_setup).toBe(false);
    const again = await request(app).post('/api/setup').send({ organisation: { name: 'X', state_code: '29' }, admin: { name: 'X', email: 'x@example.com', password: 'another-pass-1' } });
    expect(again.status).toBe(409);
  });

  it('sends security headers and JSON 404s for unknown API routes', async () => {
    const r = await request(app).get('/api/does-not-exist').set(auth());
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Not found');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('keeps user and role management with administrators only', async () => {
    const role = await request(app).post('/api/settings/roles').set(auth()).send({ name: 'Settings Editor', permissions: { settings: { view: true, edit: true } } });
    expect(role.status).toBe(200);
    const u = await request(app).post('/api/settings/users').set(auth()).send({ name: 'Editor', email: 'Editor@Example.com', password: 'editor-pass-1', role_id: role.body.id });
    expect(u.status).toBe(200);
    // Emails are stored in lower case, and sign-in is case-insensitive.
    const first = (await request(app).post('/api/auth/login').send({ email: 'EDITOR@example.com', password: 'editor-pass-1' })).body;
    expect(first.user.must_change_password).toBe(true);
    const t = first.token;
    expect((await request(app).post('/api/auth/password').set(auth(t)).send({ current: 'editor-pass-1', next: 'editor-pass-2' })).status).toBe(200);
    const adminRole = db().value<number>('SELECT id FROM roles WHERE is_admin = 1');
    expect((await request(app).put(`/api/settings/users/${u.body.id}`).set(auth(t)).send({ role_id: adminRole })).status).toBe(403);
    expect((await request(app).post('/api/settings/users').set(auth(t)).send({ name: 'Y', email: 'y@example.com', password: 'yyyy-pass-1', role_id: adminRole })).status).toBe(403);
    expect((await request(app).put(`/api/settings/roles/${role.body.id}`).set(auth(t)).send({ permissions: { sales: { view: true } } })).status).toBe(403);
    expect((await request(app).get('/api/admin/backup').set(auth(t))).status).toBe(403);
    // The last active administrator cannot be removed.
    const me = db().value<number>('SELECT id FROM users WHERE email = ?', ADMIN.email);
    expect((await request(app).put(`/api/settings/users/${me}`).set(auth()).send({ role_id: role.body.id })).status).toBe(422);
    // Saving the same role (sent as a string by a form) keeps the user signed in; a real change signs them out.
    expect((await request(app).put(`/api/settings/users/${u.body.id}`).set(auth()).send({ name: 'Editor', role_id: String(role.body.id) })).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth(t))).status).toBe(200);
    expect((await request(app).put(`/api/settings/users/${u.body.id}`).set(auth()).send({ role_id: 'abc' })).status).toBe(422);
    expect((await request(app).put(`/api/settings/users/${u.body.id}`).set(auth()).send({ role_id: String(adminRole) })).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth(t))).status).toBe(401);
  });

  it('changes a password only with the current one and signs out other sessions', async () => {
    const email = 'accounts@example.com';
    const t1 = (await request(app).post('/api/auth/login').send({ email, password: SAMPLE_USER_PASSWORD })).body.token;
    const t2 = (await request(app).post('/api/auth/login').send({ email, password: SAMPLE_USER_PASSWORD })).body.token;
    expect((await request(app).post('/api/auth/password').set(auth(t1)).send({ current: 'wrong-pass', next: 'new-pass-12345' })).status).toBe(422);
    expect((await request(app).post('/api/auth/password').set(auth(t1)).send({ current: SAMPLE_USER_PASSWORD, next: 'short' })).status).toBe(422);
    expect((await request(app).post('/api/auth/password').set(auth(t1)).send({ current: SAMPLE_USER_PASSWORD, next: 'new-pass-12345' })).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth(t1))).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth(t2))).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email, password: 'new-pass-12345' })).status).toBe(200);
  });

  it('locks an account after repeated failures and hides which emails exist', async () => {
    resetLoginThrottle();
    const email = 'purchase@example.com';
    for (let i = 0; i < 8; i++) await request(app).post('/api/auth/login').send({ email, password: 'wrong' });
    expect((await request(app).post('/api/auth/login').send({ email, password: SAMPLE_USER_PASSWORD })).status).toBe(429);
    // Unknown and known emails fail the same way.
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'x' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe('Invalid email or password');
    resetLoginThrottle();
  });

  it('checks permissions on contact statements and credits', async () => {
    const prod = (await request(app).post('/api/auth/login').send({ email: 'production@example.com', password: SAMPLE_USER_PASSWORD })).body.token;
    const vendor = db().value<number>("SELECT id FROM contacts WHERE kind = 'vendor' LIMIT 1");
    expect((await request(app).get(`/api/contacts/${vendor}/statement`).set(auth(prod))).status).toBe(403);
    expect((await request(app).get(`/api/contacts/${vendor}/credits`).set(auth(prod))).status).toBe(403);
    expect((await request(app).get(`/api/contacts/${vendor}/statement?from=bad`).set(auth())).status).toBe(422);
  });

  it('downloads a consistent database backup', async () => {
    const r = await request(app).get('/api/admin/backup').set(auth()).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/saral-backup-.*\.db/);
    expect((r.body as Buffer).subarray(0, 15).toString()).toBe('SQLite format 3');
  });

  it('exports the IRP e-invoice JSON and records the IRN', async () => {
    const inv = db().value<number>("SELECT d.id FROM documents d JOIN contacts c ON c.id = d.contact_id WHERE d.type = 'invoice' AND c.name = 'Mehta Engineering Works'");
    const j = await request(app).get(`/api/docs/invoice/${inv}/einvoice.json`).set(auth());
    expect(j.status).toBe(200);
    expect(j.headers['content-disposition']).toMatch(/einvoice_INV-\d+\.json/);
    expect(j.body).toMatchObject({ Version: '1.1', TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N' }, DocDtls: { Typ: 'INV' } });
    expect(j.body.SellerDtls).toMatchObject({ Stcd: '29', Pin: 560058, Loc: 'Bengaluru' });
    expect(j.body.BuyerDtls).toMatchObject({ Pos: '27', Stcd: '27', Pin: 411026, Loc: 'Pune' });
    expect(j.body.ValDtls.IgstVal).toBeGreaterThan(0);
    expect(j.body.ValDtls.CgstVal).toBe(0);
    const items = j.body.ItemList;
    expect(items.every((x: any) => Math.abs(x.TotAmt - x.Discount - x.AssAmt) < 0.011)).toBe(true);
    expect(Math.abs(items.reduce((a: number, x: any) => a + x.TotItemVal, 0) + j.body.ValDtls.RndOffAmt - j.body.ValDtls.TotInvVal)).toBeLessThan(0.05);
    // B2C customers are outside e-invoicing.
    const b2c = db().value<number>("SELECT d.id FROM documents d JOIN contacts c ON c.id = d.contact_id WHERE d.type = 'invoice' AND c.gst_treatment = 'consumer'");
    expect((await request(app).get(`/api/docs/invoice/${b2c}/einvoice.json`).set(auth())).status).toBe(422);
    const ewb = await request(app).post(`/api/docs/invoice/${inv}/ewaybill.json`).set(auth()).send({ distance: 840, transport_mode: 'road', vehicle_no: 'KA05AB4321' });
    expect(ewb.status).toBe(200);
    expect(ewb.body.billLists[0]).toMatchObject({ supplyType: 'O', subSupplyType: 1, docType: 'INV', fromStateCode: 29, toStateCode: 27, transMode: 1, vehicleType: 'R', transDistance: 840 });
    const bad = await request(app).post(`/api/docs/invoice/${inv}/actions/einvoice_record`).set(auth()).send({ irn: 'abc', ack_no: '1', ack_date: today() });
    expect(bad.status).toBe(422);
    db().run('UPDATE kv SET value = json_set(value, \'$.einvoice_enabled\', json(\'true\')) WHERE key = \'org\'');
    const irn = 'a'.repeat(64);
    const ok = await request(app).post(`/api/docs/invoice/${inv}/actions/einvoice_record`).set(auth()).send({ irn, ack_no: '112610000123456', ack_date: new Date().toISOString(), signed_qr: 'eyJhbGciOi.test.sig' });
    expect(ok.status).toBe(200);
    expect(ok.body.document.data.einvoice).toMatchObject({ status: 'generated', irn, ack_no: '112610000123456' });
    // An e-invoiced document is locked until the IRN is cancelled.
    expect((await request(app).put(`/api/docs/invoice/${inv}`).set(auth()).send({ contact_id: ok.body.document.contact_id, lines: [] })).status).toBe(422);
    expect((await request(app).post(`/api/docs/invoice/${inv}/actions/einvoice_cancel`).set(auth()).send({ reason_code: '2' })).status).toBe(200);
  });
});
