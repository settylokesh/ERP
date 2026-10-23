import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db.js';
import { seedDemo } from '../src/demo.js';
import { gstr1, gstr3b } from '../src/gst.js';
import { REPORTS, runReport, toCsv } from '../src/reports.js';
import { initDatabase } from '../src/seed.js';
import { today, addDays } from '../src/util.js';

const app = createApp();
let token = '';
let salesToken = '';

beforeAll(async () => {
  initDatabase(':memory:');
  seedDemo();
  token = (await request(app).post('/api/auth/login').send({ email: 'admin@saral.local', password: 'admin123' })).body.token;
  salesToken = (await request(app).post('/api/auth/login').send({ email: 'sales@saral.local', password: 'demo1234' })).body.token;
});
const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

describe('Demo company integrity', () => {
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
    expect((await request(app).post('/api/auth/login').send({ email: 'admin@saral.local', password: 'nope' })).status).toBe(401);
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
    expect(after.body.actions.some((a: any) => a.key === 'einvoice_generate')).toBe(true);
  });

  it('returns validation errors as 422 with a message', async () => {
    const res = await request(app).post('/api/docs/invoice').set(auth()).send({ lines: [] });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Customer is required/);
  });

  it('throttles repeated failed logins', async () => {
    for (let i = 0; i < 8; i++) await request(app).post('/api/auth/login').send({ email: 'hr@saral.local', password: 'wrong' });
    const r = await request(app).post('/api/auth/login').send({ email: 'hr@saral.local', password: 'demo1234' });
    expect(r.status).toBe(429);
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
});
