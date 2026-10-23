import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as acc from './accountant.js';
import { ACCOUNT_TYPES } from './ledger.js';
import { assertCan, authMiddleware, can, DEFAULT_ROLES, hashPassword, login, logout, MODULES, type PermModule } from './auth.js';
import * as bank from './banking.js';
import * as custom from './custom.js';
import { dashboard, globalSearch, runRecurring, saveRecurring } from './dashboard.js';
import { db, fail, HttpError, json, type Row } from './db.js';
import { runAction, availableActions } from './documents/actions.js';
import { assertDocPerm, convertDraft, createDocument, createFrom, deleteDocument, getDocument, listDocuments, updateDocument } from './documents/engine.js';
import { DOC_TYPES, docType } from './documents/types.js';
import * as gst from './gst.js';
import { availableBatches, availableSerials } from './inventory.js';
import * as mfg from './manufacturing.js';
import * as m from './masters.js';
import * as pay from './payments.js';
import * as payroll from './payroll.js';
import { reportCatalog, runReport, toCsv } from './reports.js';
import { DEFAULT_ORG, DEFAULT_PAYROLL, getKv, LOCK_MODULES, org, payrollSettings, setKv } from './settings.js';
import { GST_TREATMENTS, STATES, today, validateGstin } from './util.js';
import { parseCsv } from './banking.js';
import { audit } from './activity.js';

type H = (req: Request, res: Response) => unknown;
const h = (fn: H) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    next(e);
  }
};
const perm = (module: PermModule, action: 'view' | 'create' | 'edit' | 'delete' | 'approve' = 'view') => (req: Request, _res: Response, next: NextFunction) => {
  try { assertCan(req.user, module, action); next(); } catch (e) { next(e); }
};
const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) fail('Invalid id', 400);
  return n;
};

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.post('/api/auth/login', h((req) => login(req.body?.email, req.body?.password)));

  const api = express.Router();
  api.use(authMiddleware);

  api.post('/auth/logout', h((req) => logout(req.token!)));
  api.get('/auth/me', h((req) => ({ user: req.user, org: org() })));
  api.post('/auth/password', h((req) => {
    const { current, next } = req.body ?? {};
    const u = db().get<Row>('SELECT * FROM users WHERE id = ?', req.user!.id)!;
    login(u.email, current);
    if (String(next ?? '').length < 8) fail('New password must be at least 8 characters', 422);
    db().update('users', u.id, { password_hash: hashPassword(next) });
  }));

  api.get('/meta', h((req) => ({
    user: req.user,
    org: org(),
    doc_types: DOC_TYPES,
    states: STATES,
    gst_treatments: GST_TREATMENTS,
    account_types: ACCOUNT_TYPES,
    modules: MODULES,
    taxes: db().all('SELECT * FROM taxes ORDER BY is_active DESC, rate'),
    tds_sections: db().all('SELECT * FROM tds_sections WHERE is_active = 1 ORDER BY section, rate'),
    warehouses: db().all('SELECT * FROM warehouses WHERE is_active = 1 ORDER BY is_primary DESC, name'),
    currencies: db().all('SELECT * FROM currencies ORDER BY is_base DESC, code'),
    price_lists: db().all('SELECT * FROM price_lists WHERE is_active = 1 ORDER BY name'),
    custom_fields: db().all<Row>('SELECT * FROM custom_fields ORDER BY module, sort, id').map((f) => ({ ...f, options: json(f.options, []) })),
    custom_modules: custom.listCustomModules(),
    bank_txn_kinds: bank.BANK_TXN_KINDS,
    approvals: getKv('approvals', {}),
    lock_dates: getKv('lock_dates', {}),
    unread_notifications: db().value('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0', req.user!.id),
  })));

  api.get('/dashboard', h((req) => dashboard(req.user)));
  api.get('/search', h((req) => globalSearch(String(req.query.q ?? ''))));
  api.get('/notifications', h((req) => db().all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user!.id)));
  api.post('/notifications/read-all', h((req) => db().run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', req.user!.id) && { ok: true }));
  api.post('/notifications/:id/read', h((req) => db().run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', id(req), req.user!.id) && { ok: true }));

  // ---------- Contacts ----------
  const contactModule = (kind: string): PermModule => (kind === 'vendor' ? 'purchases' : 'sales');
  api.get('/contacts', h((req) => {
    const kind = String(req.query.kind ?? 'customer');
    assertCan(req.user, contactModule(kind));
    return m.listContacts(kind, req.query as Row);
  }));
  api.post('/contacts', h((req) => {
    assertCan(req.user, contactModule(req.body?.kind), 'create');
    return { id: m.saveContact(req.body, req.user) };
  }));
  api.post('/contacts/import', h((req) => {
    const kind = String(req.query.kind ?? 'customer');
    assertCan(req.user, contactModule(kind), 'create');
    const rows = parseCsv(String(req.body ?? ''));
    if (rows.length < 2) fail('CSV has no rows', 422);
    const head = rows[0].map((x) => x.trim().toLowerCase().replace(/\s+/g, '_'));
    let imported = 0;
    const errors: string[] = [];
    rows.slice(1).forEach((r, i) => {
      const o: Row = { kind };
      head.forEach((k, j) => { if (r[j] !== undefined && r[j] !== '') o[k] = r[j].trim(); });
      try { m.saveContact(o, req.user); imported++; } catch (e: any) { errors.push(`Row ${i + 2}: ${e.message}`); }
    });
    return { imported, errors };
  }));
  api.get('/contacts/:id', h((req) => {
    const c = m.getContact(id(req));
    assertCan(req.user, contactModule(c.kind));
    return c;
  }));
  api.put('/contacts/:id', h((req) => {
    const c = db().get<Row>('SELECT kind FROM contacts WHERE id = ?', id(req)) ?? fail('Contact not found', 404);
    assertCan(req.user, contactModule(c.kind), 'edit');
    return { id: m.saveContact(req.body, req.user, id(req)) };
  }));
  api.delete('/contacts/:id', h((req) => {
    const c = db().get<Row>('SELECT kind FROM contacts WHERE id = ?', id(req)) ?? fail('Contact not found', 404);
    assertCan(req.user, contactModule(c.kind), 'delete');
    m.deleteContact(id(req), req.user);
  }));
  api.get('/contacts/:id/statement', h((req) => m.contactStatement(id(req), String(req.query.from ?? `${today().slice(0, 4)}-04-01`), String(req.query.to ?? today()))));
  api.get('/contacts/:id/open-documents', h((req) => pay.openDocumentsFor(id(req), req.query.kind === 'made' ? 'made' : 'received')));
  api.get('/contacts/:id/credits', h((req) => {
    const c = db().get<Row>('SELECT kind FROM contacts WHERE id = ?', id(req)) ?? fail('Contact not found', 404);
    return pay.availableCredits(id(req), c.kind);
  }));

  // ---------- Items ----------
  api.get('/items', perm('items'), h((req) => m.listItems(req.query as Row)));
  api.post('/items', perm('items', 'create'), h((req) => ({ id: m.saveItem(req.body, req.user) })));
  api.post('/items/import', perm('items', 'create'), h((req) => {
    const rows = parseCsv(String(req.body ?? ''));
    if (rows.length < 2) fail('CSV has no rows', 422);
    const head = rows[0].map((x) => x.trim().toLowerCase().replace(/\s+/g, '_'));
    let imported = 0;
    const errors: string[] = [];
    const taxes = db().all<Row>('SELECT id, rate FROM taxes WHERE is_active = 1');
    rows.slice(1).forEach((r, i) => {
      const o: Row = {};
      head.forEach((k, j) => { if (r[j] !== undefined && r[j] !== '') o[k] = r[j].trim(); });
      if (o.gst_rate !== undefined) o.tax_id = taxes.find((t) => t.rate === Number(o.gst_rate))?.id ?? null;
      try { m.saveItem(o, req.user); imported++; } catch (e: any) { errors.push(`Row ${i + 2}: ${e.message}`); }
    });
    return { imported, errors };
  }));
  api.get('/items/:id', perm('items'), h((req) => m.getItem(id(req))));
  api.put('/items/:id', perm('items', 'edit'), h((req) => ({ id: m.saveItem(req.body, req.user, id(req)) })));
  api.delete('/items/:id', perm('items', 'delete'), h((req) => m.deleteItem(id(req), req.user)));
  api.get('/items/:id/price', h((req) => ({ rate: m.priceFor(id(req), req.query.price_list_id ? Number(req.query.price_list_id) : null, req.query.side === 'purchase' ? 'purchase' : 'sales') })));
  api.get('/items/:id/batches', h((req) => availableBatches(id(req), Number(req.query.warehouse_id))));
  api.get('/items/:id/serials', h((req) => availableSerials(id(req), Number(req.query.warehouse_id))));

  // ---------- Chart of accounts & masters ----------
  api.get('/accounts', h((req) => m.listAccounts(req.query as Row)));
  api.post('/accounts', perm('accountant', 'create'), h((req) => ({ id: m.saveAccount(req.body, req.user) })));
  api.put('/accounts/:id', perm('accountant', 'edit'), h((req) => ({ id: m.saveAccount(req.body, req.user, id(req)) })));
  api.delete('/accounts/:id', perm('accountant', 'delete'), h((req) => m.deleteAccount(id(req), req.user)));
  api.get('/accounts/:id/transactions', perm('accountant'), h((req) => acc.accountTransactions(id(req), req.query.from as string, req.query.to as string)));

  api.get('/warehouses', h(() => db().all('SELECT * FROM warehouses ORDER BY is_primary DESC, name')));
  api.post('/warehouses', perm('settings', 'edit'), h((req) => ({ id: m.saveWarehouse(req.body) })));
  api.put('/warehouses/:id', perm('settings', 'edit'), h((req) => ({ id: m.saveWarehouse(req.body, id(req)) })));
  api.get('/taxes', h(() => db().all('SELECT * FROM taxes ORDER BY rate')));
  api.post('/taxes', perm('settings', 'edit'), h((req) => ({ id: m.saveTax(req.body) })));
  api.put('/taxes/:id', perm('settings', 'edit'), h((req) => ({ id: m.saveTax(req.body, id(req)) })));
  api.get('/tds-sections', h(() => db().all('SELECT * FROM tds_sections ORDER BY section')));
  api.post('/tds-sections', perm('settings', 'edit'), h((req) => ({ id: db().insert('tds_sections', { section: req.body.section, name: req.body.name, rate: Number(req.body.rate), is_active: 1 }) })));
  api.get('/currencies', h(() => db().all('SELECT * FROM currencies ORDER BY is_base DESC, code')));
  api.post('/currencies', perm('settings', 'edit'), h((req) => {
    const code = String(req.body.code ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) fail('Currency code must be 3 letters', 422);
    if (!(Number(req.body.rate) > 0)) fail('Exchange rate must be positive', 422);
    db().run('INSERT INTO currencies (code, name, symbol, rate) VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, symbol = excluded.symbol, rate = excluded.rate', code, req.body.name ?? code, req.body.symbol ?? code, Number(req.body.rate));
  }));
  api.get('/price-lists', h(() => db().all<Row>('SELECT * FROM price_lists ORDER BY name').map((p) => ({ ...p, items: db().all('SELECT pli.*, i.name FROM price_list_items pli JOIN items i ON i.id = pli.item_id WHERE pli.price_list_id = ?', p.id) }))));
  api.post('/price-lists', perm('items', 'create'), h((req) => ({ id: m.savePriceList(req.body) })));
  api.put('/price-lists/:id', perm('items', 'edit'), h((req) => ({ id: m.savePriceList(req.body, id(req)) })));

  // ---------- Documents (sales, purchases, inventory) ----------
  api.get('/docs/:type', h((req) => { assertDocPerm(req.user, req.params.type, 'view'); return listDocuments(req.params.type, req.query as Row); }));
  api.post('/docs/:type', h((req) => {
    assertDocPerm(req.user, req.params.type, 'create');
    const newId = createDocument(req.params.type, req.body, req.user, { submit: !!req.body?.submit });
    if (req.params.type === 'purchase_receive') mfg.ensureReceiveInspections(newId, req.user);
    return getDocument(newId, req.user);
  }));
  const loadTyped = (req: Request) => {
    const doc = db().get<Row>('SELECT id, type FROM documents WHERE id = ?', id(req)) ?? fail('Document not found', 404);
    if (doc.type !== req.params.type) fail('Document type mismatch', 404);
    return doc;
  };
  api.get('/docs/:type/:id', h((req) => {
    loadTyped(req);
    assertDocPerm(req.user, req.params.type, 'view');
    const d = getDocument(id(req), req.user);
    return { ...d, actions: availableActions(d).filter((a) => a.key !== 'approve' && a.key !== 'reject' ? true : d.can_approve) };
  }));
  api.put('/docs/:type/:id', h((req) => {
    loadTyped(req);
    assertDocPerm(req.user, req.params.type, 'edit');
    updateDocument(id(req), req.body, req.user, { submit: !!req.body?.submit });
    return getDocument(id(req), req.user);
  }));
  api.delete('/docs/:type/:id', h((req) => { loadTyped(req); assertDocPerm(req.user, req.params.type, 'delete'); deleteDocument(id(req), req.user); }));
  api.post('/docs/:type/:id/actions/:action', h((req) => {
    loadTyped(req);
    assertDocPerm(req.user, req.params.type, 'view');
    const out = runAction(id(req), req.params.action, req.body ?? {}, req.user);
    return { ...out, document: { ...out.document, actions: availableActions(out.document) } };
  }));
  api.get('/docs/:type/:id/convert/:to', h((req) => {
    loadTyped(req);
    assertDocPerm(req.user, req.params.to, 'create');
    return convertDraft(id(req), req.params.to, req.query as Row);
  }));
  api.post('/docs/:type/:id/convert/:to', h((req) => {
    loadTyped(req);
    assertDocPerm(req.user, req.params.to, 'create');
    const newId = createFrom(id(req), req.params.to, req.user, req.body ?? {}, req.body?.submit !== false);
    if (req.params.to === 'purchase_receive') mfg.ensureReceiveInspections(newId, req.user);
    return { id: newId, type: req.params.to };
  }));

  // ---------- Payments, credits, refunds ----------
  const payModule = (kind: string): PermModule => (kind === 'made' ? 'purchases' : 'sales');
  api.get('/payments/:kind', h((req) => { assertCan(req.user, payModule(req.params.kind)); return pay.listPayments(req.params.kind, req.query as Row); }));
  api.post('/payments/:kind', h((req) => {
    assertCan(req.user, payModule(req.params.kind), 'create');
    return pay.getPayment(pay.createPayment({ ...req.body, kind: req.params.kind as 'received' | 'made' }, req.user));
  }));
  api.get('/payments/:kind/:id', h((req) => { assertCan(req.user, payModule(req.params.kind)); return pay.getPayment(id(req)); }));
  api.put('/payments/:kind/:id', h((req) => {
    assertCan(req.user, payModule(req.params.kind), 'edit');
    return pay.getPayment(pay.updatePayment(id(req), { ...req.body, kind: req.params.kind as 'received' | 'made' }, req.user));
  }));
  api.delete('/payments/:kind/:id', h((req) => { assertCan(req.user, payModule(req.params.kind), 'delete'); pay.deletePayment(id(req), req.user); }));
  api.post('/credits/apply', h((req) => {
    assertCan(req.user, 'sales', 'edit');
    return { applied: pay.applyCredits({ credit_doc_id: req.body.credit_doc_id, payment_id: req.body.payment_id }, req.body.allocations ?? [], req.user, req.body.date) };
  }));
  api.delete('/credits/:id', h((req) => { assertCan(req.user, 'sales', 'edit'); pay.removeCreditApplication(id(req), req.user); }));
  api.post('/refunds', h((req) => { assertCan(req.user, 'sales', 'edit'); return { id: pay.createRefund(req.body, req.user) }; }));
  api.delete('/refunds/:id', h((req) => { assertCan(req.user, 'sales', 'delete'); pay.deleteRefund(id(req), req.user); }));

  // ---------- Accountant ----------
  api.get('/journals', perm('accountant'), h((req) => acc.listManualJournals(req.query as Row)));
  api.post('/journals', perm('accountant', 'create'), h((req) => acc.getManualJournal(acc.saveManualJournal(req.body, req.user))));
  api.get('/journals/:id', perm('accountant'), h((req) => acc.getManualJournal(id(req))));
  api.put('/journals/:id', perm('accountant', 'edit'), h((req) => acc.getManualJournal(acc.saveManualJournal(req.body, req.user, id(req)))));
  api.delete('/journals/:id', perm('accountant', 'delete'), h((req) => acc.deleteManualJournal(id(req), req.user)));
  api.post('/journals/:id/reverse', perm('accountant', 'create'), h((req) => ({ id: acc.reverseManualJournal(id(req), req.body?.date, req.user) })));

  api.get('/asset-types', perm('assets'), h(() => db().all('SELECT * FROM asset_types ORDER BY name')));
  api.post('/asset-types', perm('assets', 'create'), h((req) => ({ id: acc.saveAssetType(req.body) })));
  api.put('/asset-types/:id', perm('assets', 'edit'), h((req) => ({ id: acc.saveAssetType(req.body, id(req)) })));
  api.get('/assets', perm('assets'), h(() => acc.listAssets()));
  api.post('/assets', perm('assets', 'create'), h((req) => acc.getAsset(acc.saveAsset(req.body, req.user))));
  api.post('/assets/depreciate', perm('assets', 'edit'), h((req) => ({ posted: acc.runDepreciation(req.body?.upto ?? today(), req.user) })));
  api.get('/assets/:id', perm('assets'), h((req) => acc.getAsset(id(req))));
  api.put('/assets/:id', perm('assets', 'edit'), h((req) => acc.getAsset(acc.saveAsset(req.body, req.user, id(req)))));
  api.delete('/assets/:id', perm('assets', 'delete'), h((req) => {
    const a = db().get<Row>('SELECT status FROM assets WHERE id = ?', id(req)) ?? fail('Asset not found', 404);
    if (a.status !== 'draft') fail('Only draft assets can be deleted', 422);
    db().run('DELETE FROM assets WHERE id = ?', id(req));
  }));
  api.post('/assets/:id/register', perm('assets', 'edit'), h((req) => { acc.registerAsset(id(req), req.user); return acc.getAsset(id(req)); }));
  api.post('/assets/:id/dispose', perm('assets', 'edit'), h((req) => { acc.disposeAsset(id(req), req.body ?? {}, req.user); return acc.getAsset(id(req)); }));

  api.get('/budgets', perm('accountant'), h(() => db().all('SELECT * FROM budgets ORDER BY fiscal_year DESC, name')));
  api.post('/budgets', perm('accountant', 'create'), h((req) => ({ id: acc.saveBudget(req.body) })));
  api.get('/budgets/:id', perm('accountant'), h((req) => ({ ...(db().get('SELECT * FROM budgets WHERE id = ?', id(req)) ?? fail('Budget not found', 404)), lines: db().all<Row>('SELECT bl.*, a.name AS account_name FROM budget_lines bl JOIN accounts a ON a.id = bl.account_id WHERE budget_id = ?', id(req)).map((l) => ({ ...l, amounts: json(l.amounts, []) })) })));
  api.put('/budgets/:id', perm('accountant', 'edit'), h((req) => ({ id: acc.saveBudget(req.body, id(req)) })));
  api.delete('/budgets/:id', perm('accountant', 'delete'), h((req) => db().run('DELETE FROM budgets WHERE id = ?', id(req)) && { ok: true }));
  api.get('/budgets/:id/report', perm('reports'), h((req) => acc.budgetVsActual(id(req))));

  // ---------- Banking ----------
  api.get('/banking/accounts', perm('banking'), h(() => bank.bankAccounts()));
  api.get('/banking/kinds', h(() => bank.BANK_TXN_KINDS));
  api.get('/banking/accounts/:id/statement', perm('banking'), h((req) => bank.statementLines(id(req), req.query.status as string)));
  api.post('/banking/accounts/:id/import', perm('banking', 'create'), h((req) => bank.importStatement(id(req), typeof req.body === 'string' ? req.body : String(req.body?.csv ?? ''), req.user)));
  api.get('/banking/lines/:id/matches', perm('banking'), h((req) => bank.matchSuggestions(id(req))));
  api.post('/banking/lines/:id/match', perm('banking', 'edit'), h((req) => bank.matchLine(id(req), req.body.source_type, Number(req.body.source_id), req.user)));
  api.post('/banking/lines/:id/categorize', perm('banking', 'create'), h((req) => bank.categorizeLine(id(req), req.body ?? {}, req.user)));
  api.post('/banking/lines/:id/status', perm('banking', 'edit'), h((req) => bank.setLineStatus(id(req), req.body.status === 'excluded' ? 'excluded' : 'uncategorized')));
  api.get('/banking/transactions', perm('banking'), h((req) => db().all(
    `SELECT t.*, a.name AS account_name, o.name AS offset_name FROM bank_transactions t JOIN accounts a ON a.id = t.account_id JOIN accounts o ON o.id = t.offset_account_id
     ${req.query.account_id ? 'WHERE t.account_id = ? OR t.offset_account_id = ?' : ''} ORDER BY t.date DESC, t.id DESC LIMIT 500`, ...(req.query.account_id ? [req.query.account_id, req.query.account_id] : []))));
  api.post('/banking/transactions', perm('banking', 'create'), h((req) => ({ id: bank.saveBankTransaction(req.body, req.user) })));
  api.put('/banking/transactions/:id', perm('banking', 'edit'), h((req) => ({ id: bank.saveBankTransaction(req.body, req.user, id(req)) })));
  api.delete('/banking/transactions/:id', perm('banking', 'delete'), h((req) => bank.deleteBankTransaction(id(req), req.user)));
  api.get('/banking/reconcile', perm('banking'), h((req) => bank.reconciliationData(Number(req.query.account_id), String(req.query.end_date ?? today()))));
  api.post('/banking/reconcile', perm('banking', 'edit'), h((req) => ({ id: bank.completeReconciliation(req.body, req.user) })));
  api.get('/banking/reconciliations', perm('banking'), h((req) => bank.listReconciliations(Number(req.query.account_id))));
  api.delete('/banking/reconciliations/:id', perm('banking', 'edit'), h((req) => bank.undoReconciliation(id(req), req.user)));

  // ---------- Manufacturing ----------
  api.get('/manufacturing/work-centers', perm('manufacturing'), h(() => mfg.listWorkCenters()));
  api.post('/manufacturing/work-centers', perm('manufacturing', 'create'), h((req) => ({ id: mfg.saveWorkCenter(req.body) })));
  api.put('/manufacturing/work-centers/:id', perm('manufacturing', 'edit'), h((req) => ({ id: mfg.saveWorkCenter(req.body, id(req)) })));
  api.get('/manufacturing/boms', perm('manufacturing'), h(() => db().all('SELECT b.*, i.name AS item_name, (SELECT COUNT(*) FROM bom_components WHERE bom_id = b.id) AS components FROM boms b JOIN items i ON i.id = b.item_id ORDER BY b.id DESC')));
  api.post('/manufacturing/boms', perm('manufacturing', 'create'), h((req) => mfg.getBom(mfg.saveBom(req.body, req.user))));
  api.get('/manufacturing/boms/:id', perm('manufacturing'), h((req) => mfg.getBom(id(req))));
  api.put('/manufacturing/boms/:id', perm('manufacturing', 'edit'), h((req) => mfg.getBom(mfg.saveBom(req.body, req.user, id(req)))));
  api.delete('/manufacturing/boms/:id', perm('manufacturing', 'delete'), h((req) => mfg.deleteBom(id(req))));
  api.get('/manufacturing/orders', perm('manufacturing'), h((req) => mfg.listMos(req.query as Row)));
  api.post('/manufacturing/orders', perm('manufacturing', 'create'), h((req) => mfg.getMo(mfg.saveMo(req.body, req.user))));
  api.post('/manufacturing/orders/from-sales-order/:id', perm('manufacturing', 'create'), h((req) => ({ created: mfg.mosFromSalesOrder(id(req), req.user) })));
  api.get('/manufacturing/orders/:id', perm('manufacturing'), h((req) => mfg.getMo(id(req))));
  api.put('/manufacturing/orders/:id', perm('manufacturing', 'edit'), h((req) => mfg.getMo(mfg.saveMo(req.body, req.user, id(req)))));
  api.delete('/manufacturing/orders/:id', perm('manufacturing', 'delete'), h((req) => mfg.deleteMo(id(req), req.user)));
  api.post('/manufacturing/orders/:id/confirm', perm('manufacturing', 'edit'), h((req) => ({ ...mfg.confirmMo(id(req), req.user), order: mfg.getMo(id(req)) })));
  api.post('/manufacturing/orders/:id/complete', perm('manufacturing', 'edit'), h((req) => { mfg.completeMo(id(req), req.body ?? {}, req.user); return mfg.getMo(id(req)); }));
  api.post('/manufacturing/orders/:id/cancel', perm('manufacturing', 'edit'), h((req) => { mfg.cancelMo(id(req), req.user); return mfg.getMo(id(req)); }));
  api.post('/manufacturing/job-cards/:id/:action', perm('manufacturing', 'edit'), h((req) => { mfg.jobCardAction(id(req), req.params.action, req.body ?? {}, req.user); return db().get('SELECT * FROM job_cards WHERE id = ?', id(req)); }));
  api.get('/manufacturing/job-cards', perm('manufacturing'), h((req) => db().all(
    `SELECT jc.*, w.name AS work_center_name, mo.number AS mo_number, i.name AS item_name, e.name AS employee_name FROM job_cards jc JOIN work_centers w ON w.id = jc.work_center_id
     JOIN manufacturing_orders mo ON mo.id = jc.mo_id JOIN items i ON i.id = mo.item_id LEFT JOIN employees e ON e.id = jc.employee_id
     ${req.query.status ? 'WHERE jc.status = ?' : ''} ORDER BY jc.id DESC LIMIT 500`, ...(req.query.status ? [req.query.status] : []))));
  api.get('/manufacturing/shop-floor', perm('manufacturing'), h(() => mfg.shopFloor()));
  api.get('/manufacturing/calendar', perm('manufacturing'), h((req) => mfg.workCenterCalendar(String(req.query.from ?? today()), String(req.query.to ?? today()))));
  api.get('/manufacturing/mrp', perm('manufacturing'), h(() => mfg.mrp()));
  api.get('/manufacturing/quality-rules', perm('manufacturing'), h(() => db().all<Row>('SELECT q.*, i.name AS item_name FROM quality_rules q JOIN items i ON i.id = q.item_id ORDER BY q.id DESC').map((r) => ({ ...r, parameters: json(r.parameters, []) }))));
  api.post('/manufacturing/quality-rules', perm('manufacturing', 'create'), h((req) => ({ id: mfg.saveQualityRule(req.body) })));
  api.put('/manufacturing/quality-rules/:id', perm('manufacturing', 'edit'), h((req) => ({ id: mfg.saveQualityRule(req.body, id(req)) })));
  api.get('/manufacturing/inspections', perm('manufacturing'), h((req) => mfg.listInspections(req.query as Row)));
  api.post('/manufacturing/inspections', perm('manufacturing', 'create'), h((req) => mfg.getInspection(mfg.createInspection(req.body, req.user))));
  api.get('/manufacturing/inspections/:id', perm('manufacturing'), h((req) => mfg.getInspection(id(req))));
  api.post('/manufacturing/inspections/:id/record', perm('manufacturing', 'edit'), h((req) => { mfg.recordInspection(id(req), req.body ?? {}, req.user); return mfg.getInspection(id(req)); }));

  // ---------- People & payroll ----------
  api.get('/payroll/employees', perm('payroll'), h((req) => payroll.listEmployees(req.query as Row)));
  api.post('/payroll/employees', perm('payroll', 'create'), h((req) => payroll.getEmployee(payroll.saveEmployee(req.body, req.user))));
  api.get('/payroll/employees/:id', perm('payroll'), h((req) => payroll.getEmployee(id(req))));
  api.put('/payroll/employees/:id', perm('payroll', 'edit'), h((req) => payroll.getEmployee(payroll.saveEmployee(req.body, req.user, id(req)))));
  for (const t of ['departments', 'designations'] as const) {
    api.get(`/payroll/${t}`, h(() => db().all(`SELECT * FROM ${t} ORDER BY name`)));
    api.post(`/payroll/${t}`, perm('payroll', 'create'), h((req) => {
      const name = String(req.body?.name ?? '').trim() || fail('Name is required', 422);
      if (db().get(`SELECT 1 FROM ${t} WHERE name = ?`, name)) fail('Already exists', 409);
      return { id: db().insert(t, { name }) };
    }));
  }
  api.get('/payroll/components', perm('payroll'), h(() => db().all('SELECT * FROM salary_components ORDER BY sort, id')));
  api.post('/payroll/components', perm('payroll', 'create'), h((req) => {
    const b = req.body ?? {};
    if (!/^[A-Z][A-Z0-9_]{1,15}$/.test(String(b.code ?? ''))) fail('Code must be uppercase letters/numbers', 422);
    if (!['pct_ctc', 'pct_basic', 'fixed', 'balance'].includes(b.calc)) fail('Invalid calculation type', 422);
    if (b.calc === 'balance' && db().get("SELECT 1 FROM salary_components WHERE calc = 'balance' AND is_active = 1")) fail('Only one balancing component is allowed', 422);
    return { id: db().insert('salary_components', { code: b.code, name: b.name, kind: 'earning', calc: b.calc, value: Number(b.value) || 0, pf_applicable: b.pf_applicable ? 1 : 0, esi_applicable: b.esi_applicable === false ? 0 : 1, taxable: 1, sort: Number(b.sort) || 5 }) };
  }));
  api.put('/payroll/components/:id', perm('payroll', 'edit'), h((req) => {
    const b = req.body ?? {};
    db().update('salary_components', id(req), { name: b.name, value: Number(b.value) || 0, pf_applicable: b.pf_applicable ? 1 : 0, esi_applicable: b.esi_applicable === false ? 0 : 1, is_active: b.is_active === false ? 0 : 1 });
  }));
  api.get('/payroll/pt-slabs', perm('payroll'), h(() => db().all('SELECT * FROM pt_slabs ORDER BY state_code, min_salary')));
  api.put('/payroll/pt-slabs', perm('payroll', 'edit'), h((req) => db().tx(() => {
    const state = String(req.body.state_code ?? '');
    if (!STATES[state]) fail('Invalid state', 422);
    db().run('DELETE FROM pt_slabs WHERE state_code = ?', state);
    for (const s of req.body.slabs ?? []) db().insert('pt_slabs', { state_code: state, min_salary: Number(s.min_salary) || 0, max_salary: s.max_salary === '' || s.max_salary == null ? null : Number(s.max_salary), amount: Number(s.amount) || 0, feb_amount: s.feb_amount === '' || s.feb_amount == null ? null : Number(s.feb_amount) });
    return { ok: true };
  })));
  api.get('/payroll/pay-runs', perm('payroll'), h(() => payroll.listPayRuns()));
  api.post('/payroll/pay-runs', perm('payroll', 'create'), h((req) => payroll.getPayRun(payroll.createPayRun(req.body ?? {}, req.user))));
  api.get('/payroll/pay-runs/:id', perm('payroll'), h((req) => payroll.getPayRun(id(req))));
  api.delete('/payroll/pay-runs/:id', perm('payroll', 'delete'), h((req) => payroll.deletePayRun(id(req), req.user)));
  api.post('/payroll/pay-runs/:id/recalculate', perm('payroll', 'edit'), h((req) => { payroll.recalculatePayRun(id(req)); return payroll.getPayRun(id(req)); }));
  api.post('/payroll/pay-runs/:id/approve', perm('payroll', 'approve'), h((req) => { payroll.approvePayRun(id(req), req.user); return payroll.getPayRun(id(req)); }));
  api.post('/payroll/pay-runs/:id/pay', perm('payroll', 'edit'), h((req) => { payroll.recordPayRunPayment(id(req), req.body ?? {}, req.user); return payroll.getPayRun(id(req)); }));
  api.get('/payroll/payslips/:id', perm('payroll'), h((req) => payroll.getPayslip(id(req))));
  api.put('/payroll/payslips/:id', perm('payroll', 'edit'), h((req) => { payroll.updatePayslip(id(req), req.body ?? {}, req.user); return payroll.getPayslip(id(req)); }));
  api.post('/payroll/payslips/:id/release', perm('payroll', 'edit'), h((req) => { payroll.releaseWithheld(id(req), req.body ?? {}, req.user); return payroll.getPayslip(id(req)); }));

  // ---------- GST compliance ----------
  api.get('/gst/gstr1', perm('compliance'), h((req) => gst.gstr1(String(req.query.period ?? today().slice(0, 7)))));
  api.get('/gst/gstr1/json', perm('compliance'), (req, res, next) => {
    try {
      const r = gst.gstr1(String(req.query.period ?? today().slice(0, 7)));
      res.setHeader('content-disposition', `attachment; filename="GSTR1_${r.gstin}_${r.period}.json"`);
      res.json(r.json);
    } catch (e) { next(e); }
  });
  api.get('/gst/gstr3b', perm('compliance'), h((req) => gst.gstr3b(String(req.query.period ?? today().slice(0, 7)))));
  api.post('/gst/gstr2b/reconcile', perm('compliance', 'edit'), h((req) => gst.reconcile2b(String(req.body.period), req.body.entries ?? [])));
  api.get('/gst/einvoices', perm('compliance'), h(() => db().all<Row>(
    `SELECT d.id, d.type, d.number, d.date, d.total, c.name AS contact_name, c.gstin, json_extract(d.data,'$.einvoice.status') AS einvoice_status, json_extract(d.data,'$.einvoice.irn') AS irn,
            json_extract(d.data,'$.einvoice.ack_no') AS ack_no, json_extract(d.data,'$.ewaybill.status') AS ewaybill_status, json_extract(d.data,'$.ewaybill.ewb_no') AS ewb_no,
            json_extract(d.data,'$.ewaybill.valid_until') AS ewb_valid_until
     FROM documents d JOIN contacts c ON c.id = d.contact_id WHERE d.type IN ('invoice','credit_note','delivery_challan') AND d.status NOT IN ('draft','void') ORDER BY d.date DESC LIMIT 500`)));

  // ---------- Reports ----------
  api.get('/reports', perm('reports'), h(() => reportCatalog()));
  api.get('/reports/:key', perm('reports'), (req, res, next) => {
    try {
      const key = req.params.key.replace(/\.csv$/, '');
      const r = runReport(key, req.query as Row);
      if (req.params.key.endsWith('.csv')) {
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="${key}.csv"`);
        res.send(toCsv(r));
      } else res.json(r);
    } catch (e) { next(e); }
  });

  // ---------- Recurring invoices ----------
  api.get('/recurring', perm('sales'), h(() => db().all<Row>('SELECT r.*, c.name AS contact_name FROM recurring_profiles r JOIN contacts c ON c.id = r.contact_id ORDER BY r.id DESC').map((r) => ({ ...r, template: json(r.template, {}) }))));
  api.post('/recurring', perm('sales', 'create'), h((req) => ({ id: saveRecurring(req.body) })));
  api.put('/recurring/:id', perm('sales', 'edit'), h((req) => ({ id: saveRecurring(req.body, id(req)) })));
  api.delete('/recurring/:id', perm('sales', 'delete'), h((req) => db().run('DELETE FROM recurring_profiles WHERE id = ?', id(req)) && { ok: true }));
  api.post('/recurring/run', perm('sales', 'create'), h((req) => ({ created: runRecurring(req.body?.upto ?? today(), req.user) })));

  // ---------- Custom modules ----------
  api.get('/custom-modules', h(() => custom.listCustomModules()));
  api.post('/custom-modules', perm('settings', 'edit'), h((req) => ({ id: custom.saveCustomModule(req.body, req.user) })));
  api.put('/custom-modules/:id', perm('settings', 'edit'), h((req) => ({ id: custom.saveCustomModule(req.body, req.user, id(req)) })));
  api.delete('/custom-modules/:id', perm('settings', 'edit'), h((req) => db().run('DELETE FROM custom_modules WHERE id = ?', id(req)) && { ok: true }));
  api.get('/custom/:key', perm('custom'), h((req) => custom.listCustomRecords(req.params.key, req.query as Row)));
  api.post('/custom/:key', perm('custom', 'create'), h((req) => ({ id: custom.saveCustomRecord(req.params.key, req.body ?? {}, req.user) })));
  api.get('/custom/:key/:id', perm('custom'), h((req) => {
    const mod = custom.moduleByKey(req.params.key);
    const r = db().get<Row>('SELECT * FROM custom_records WHERE id = ? AND module_id = ?', id(req), mod.id) ?? fail('Record not found', 404);
    return { ...r, data: json(r.data, {}), module: mod };
  }));
  api.put('/custom/:key/:id', perm('custom', 'edit'), h((req) => ({ id: custom.saveCustomRecord(req.params.key, req.body ?? {}, req.user, id(req)) })));
  api.delete('/custom/:key/:id', perm('custom', 'delete'), h((req) => custom.deleteCustomRecord(req.params.key, id(req), req.user)));

  // ---------- Settings ----------
  api.get('/settings/org', h(() => org()));
  api.put('/settings/org', perm('settings', 'edit'), h((req) => {
    const next = { ...org(), ...req.body };
    if (!STATES[next.state_code]) fail('Invalid state', 422);
    if (!['fifo', 'wac'].includes(next.valuation_method)) fail('Invalid valuation method', 422);
    if (next.gstin) {
      const err = validateGstin(next.gstin);
      if (err) fail(err, 422);
      if (next.gstin.slice(0, 2) !== next.state_code) fail('GSTIN state code does not match the organisation state', 422);
    }
    if (next.valuation_method !== org().valuation_method && db().get("SELECT 1 FROM stock_moves WHERE source_type <> 'item_opening'")) fail('Valuation method cannot change after stock transactions exist', 422);
    for (const k of Object.keys(next)) if (!(k in DEFAULT_ORG)) delete (next as Row)[k];
    setKv('org', next);
    audit('settings', null, 'updated', 'Organisation profile updated', req.user);
    return next;
  }));
  api.get('/settings/payroll', perm('payroll'), h(() => payrollSettings()));
  api.put('/settings/payroll', perm('payroll', 'edit'), h((req) => {
    const next = { ...payrollSettings(), ...req.body };
    for (const k of Object.keys(next)) if (!(k in DEFAULT_PAYROLL)) delete (next as Row)[k];
    setKv('payroll', next);
    return payrollSettings();
  }));
  api.get('/settings/lock-dates', h(() => getKv('lock_dates', {})));
  api.put('/settings/lock-dates', perm('accountant', 'approve'), h((req) => {
    const next: Row = {};
    for (const k of [...LOCK_MODULES, 'all']) {
      const v = req.body?.[k];
      if (v) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(`Invalid lock date for ${k}`, 422);
        next[k] = v;
      }
    }
    setKv('lock_dates', next);
    audit('settings', null, 'locked', `Transaction lock dates set: ${JSON.stringify(next)}`, req.user);
    return next;
  }));
  api.get('/settings/approvals', h(() => getKv('approvals', {})));
  api.put('/settings/approvals', perm('settings', 'edit'), h((req) => {
    const next: Row = {};
    for (const [type, cfg] of Object.entries<Row>(req.body ?? {})) {
      if (!DOC_TYPES[type]?.approvable) fail(`${type} does not support approvals`, 422);
      if (!['none', 'simple', 'multi'].includes(cfg.mode)) fail('Invalid approval mode', 422);
      const levels = (cfg.levels ?? []).map(Number).filter((n: number) => db().get('SELECT 1 FROM roles WHERE id = ?', n));
      if (cfg.mode === 'multi' && !levels.length) fail('Multi-level approval needs at least one approver role', 422);
      next[type] = { mode: cfg.mode, levels };
    }
    setKv('approvals', next);
    return next;
  }));
  api.get('/settings/sequences', h(() => db().all('SELECT * FROM sequences ORDER BY type')));
  api.put('/settings/sequences/:type', perm('settings', 'edit'), h((req) => {
    const { prefix, next_no, padding } = req.body ?? {};
    if (!(Number(next_no) >= 1)) fail('Next number must be at least 1', 422);
    db().run('INSERT INTO sequences (type, prefix, next_no, padding) VALUES (?,?,?,?) ON CONFLICT(type) DO UPDATE SET prefix = excluded.prefix, next_no = excluded.next_no, padding = excluded.padding',
      req.params.type, String(prefix ?? ''), Number(next_no), Math.min(10, Math.max(1, Number(padding) || 5)));
  }));
  api.get('/settings/users', perm('settings'), h(() => db().all('SELECT u.id, u.name, u.email, u.role_id, u.is_active, u.created_at, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.name')));
  api.post('/settings/users', perm('settings', 'edit'), h((req) => {
    const { name, email, password, role_id } = req.body ?? {};
    if (!name || !/^[^\s@]+@[^\s@]+$/.test(email ?? '')) fail('Name and a valid email are required', 422);
    if (String(password ?? '').length < 8) fail('Password must be at least 8 characters', 422);
    if (!db().get('SELECT 1 FROM roles WHERE id = ?', role_id)) fail('Role not found', 422);
    if (db().get('SELECT 1 FROM users WHERE email = ?', email)) fail('A user with this email already exists', 409);
    return { id: db().insert('users', { name, email, password_hash: hashPassword(password), role_id }) };
  }));
  api.put('/settings/users/:id', perm('settings', 'edit'), h((req) => {
    const b = req.body ?? {};
    if (id(req) === req.user!.id && b.is_active === false) fail('You cannot deactivate yourself', 422);
    if (b.role_id && !db().get('SELECT 1 FROM roles WHERE id = ?', b.role_id)) fail('Role not found', 422);
    db().update('users', id(req), { name: b.name, role_id: b.role_id, is_active: b.is_active === undefined ? undefined : b.is_active ? 1 : 0, password_hash: b.password ? hashPassword(b.password) : undefined });
    if (b.is_active === false) db().run('DELETE FROM sessions WHERE user_id = ?', id(req));
  }));
  api.get('/settings/roles', h(() => db().all<Row>('SELECT * FROM roles ORDER BY id').map((r) => ({ ...r, permissions: json(r.permissions, {}), users: db().value('SELECT COUNT(*) FROM users WHERE role_id = ?', r.id) }))));
  api.post('/settings/roles', perm('settings', 'edit'), h((req) => {
    const name = String(req.body?.name ?? '').trim() || fail('Role name is required', 422);
    if (db().get('SELECT 1 FROM roles WHERE name = ?', name)) fail('Role already exists', 409);
    return { id: db().insert('roles', { name, description: req.body.description ?? null, permissions: JSON.stringify(req.body.permissions ?? {}) }) };
  }));
  api.put('/settings/roles/:id', perm('settings', 'edit'), h((req) => {
    const r = db().get<Row>('SELECT * FROM roles WHERE id = ?', id(req)) ?? fail('Role not found', 404);
    if (r.is_admin) fail('The Admin role cannot be changed', 422);
    db().update('roles', id(req), { name: req.body.name ?? r.name, description: req.body.description ?? r.description, permissions: JSON.stringify(req.body.permissions ?? json(r.permissions, {})) });
  }));
  api.delete('/settings/roles/:id', perm('settings', 'edit'), h((req) => {
    const r = db().get<Row>('SELECT * FROM roles WHERE id = ?', id(req)) ?? fail('Role not found', 404);
    if (r.is_admin) fail('The Admin role cannot be deleted', 422);
    if (db().get('SELECT 1 FROM users WHERE role_id = ?', id(req))) fail('Reassign the users of this role first', 422);
    db().run('DELETE FROM roles WHERE id = ?', id(req));
  }));
  api.get('/settings/custom-fields', h(() => db().all<Row>('SELECT * FROM custom_fields ORDER BY module, sort').map((f) => ({ ...f, options: json(f.options, []) }))));
  api.post('/settings/custom-fields', perm('settings', 'edit'), h((req) => ({ id: custom.saveCustomField(req.body) })));
  api.put('/settings/custom-fields/:id', perm('settings', 'edit'), h((req) => ({ id: custom.saveCustomField(req.body, id(req)) })));
  api.delete('/settings/custom-fields/:id', perm('settings', 'edit'), h((req) => db().run('DELETE FROM custom_fields WHERE id = ?', id(req)) && { ok: true }));
  api.get('/settings/workflows', perm('settings'), h(() => db().all<Row>('SELECT * FROM workflow_rules ORDER BY id DESC').map((w) => ({ ...w, conditions: json(w.conditions, []), actions: json(w.actions, []) }))));
  api.post('/settings/workflows', perm('settings', 'edit'), h((req) => ({ id: custom.saveWorkflow(req.body) })));
  api.put('/settings/workflows/:id', perm('settings', 'edit'), h((req) => ({ id: custom.saveWorkflow(req.body, id(req)) })));
  api.delete('/settings/workflows/:id', perm('settings', 'edit'), h((req) => db().run('DELETE FROM workflow_rules WHERE id = ?', id(req)) && { ok: true }));
  api.get('/settings/workflow-log', perm('settings'), h(() => db().all('SELECT l.*, w.name FROM workflow_log l LEFT JOIN workflow_rules w ON w.id = l.rule_id ORDER BY l.id DESC LIMIT 300')));
  api.get('/settings/email-log', perm('settings'), h(() => db().all('SELECT * FROM email_outbox ORDER BY id DESC LIMIT 300')));
  api.get('/settings/default-roles', perm('settings'), h(() => DEFAULT_ROLES));
  api.get('/permissions/check', h((req) => ({ allowed: can(req.user, String(req.query.module), (req.query.action as any) ?? 'view') })));

  app.use('/api', api);

  // Serve the built web app in production.
  const webDist = path.resolve(process.cwd(), '../web/dist');
  const altDist = path.resolve(process.cwd(), 'web/dist');
  const dist = existsSync(webDist) ? webDist : existsSync(altDist) ? altDist : null;
  if (dist) {
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const status = err instanceof HttpError ? err.status : err?.status ?? (err?.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? `Internal error: ${err?.message ?? err}` : err.message, details: err?.details });
  });
  return app;
}
