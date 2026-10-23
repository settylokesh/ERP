import { audit } from './activity.js';
import type { AuthUser } from './auth.js';
import { db, fail, json, type Row } from './db.js';
import { postItemOpening } from './documents/posting.js';
import { availableBatches, availableSerials, stockSummary } from './inventory.js';
import { ACCOUNT_TYPES, accountBalance, acct, categoryOf, replaceJournal } from './ledger.js';
import { assertUnlocked, org } from './settings.js';
import { GST_TREATMENTS, isRegistered, r2, STATES, validateGstin } from './util.js';

const str = (v: unknown) => (v == null ? null : String(v).trim() || null);

// ---------------- Contacts ----------------

export function saveContact(input: Row, user?: AuthUser, id?: number) {
  return db().tx(() => {
    const d = db();
    const existing = id ? d.get<Row>('SELECT * FROM contacts WHERE id = ?', id) ?? fail('Contact not found', 404) : null;
    const kind = existing?.kind ?? input.kind;
    if (!['customer', 'vendor'].includes(kind)) fail('Contact type must be customer or vendor', 422);
    const name = str(input.name) ?? fail('Display name is required', 422);
    const gst_treatment = input.gst_treatment ?? existing?.gst_treatment ?? 'business_gst';
    if (!GST_TREATMENTS[gst_treatment]) fail('Invalid GST treatment', 422);
    let gstin = str(input.gstin)?.toUpperCase() ?? null;
    if (isRegistered(gst_treatment)) {
      const err = validateGstin(gstin);
      if (err) fail(err, 422);
    } else if (gst_treatment !== 'overseas') gstin = null;
    let place_of_supply = input.place_of_supply ?? (gstin ? gstin.slice(0, 2) : org().state_code);
    if (gst_treatment === 'overseas') place_of_supply = '96';
    if (!STATES[place_of_supply]) fail('Place of supply is invalid', 422);
    const pan = str(input.pan)?.toUpperCase() ?? (gstin ? gstin.slice(2, 12) : null);
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) fail('PAN format is invalid', 422);
    const email = str(input.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Email address is invalid', 422);
    const dupe = d.get<Row>('SELECT id FROM contacts WHERE kind = ? AND name = ? COLLATE NOCASE AND id <> ?', kind, name, id ?? -1);
    if (dupe) fail(`A ${kind} named "${name}" already exists`, 409);
    const row = {
      kind, name, company_name: str(input.company_name), email, phone: str(input.phone), gst_treatment, gstin, pan, place_of_supply,
      billing_address: str(input.billing_address), shipping_address: str(input.shipping_address),
      payment_terms: Math.max(0, Number(input.payment_terms ?? existing?.payment_terms ?? 0) || 0),
      currency_code: input.currency_code ?? existing?.currency_code ?? 'INR', credit_limit: input.credit_limit === '' || input.credit_limit == null ? null : Number(input.credit_limit),
      price_list_id: input.price_list_id || null, opening_balance: r2(Number(input.opening_balance ?? existing?.opening_balance ?? 0)),
      tds_section_id: input.tds_section_id || null, notes: str(input.notes), is_active: input.is_active === false ? 0 : 1,
      custom: JSON.stringify(input.custom ?? json(existing?.custom, {})), updated_at: new Date().toISOString(),
    };
    if (!d.get('SELECT 1 FROM currencies WHERE code = ?', row.currency_code)) fail('Unknown currency', 422);
    const cid = existing ? (d.update('contacts', existing.id, row), existing.id) : d.insert('contacts', row);
    postContactOpening(cid);
    audit('contact', cid, existing ? 'updated' : 'created', `${kind} ${name} ${existing ? 'updated' : 'created'}`, user);
    return cid;
  });
}

/** Opening balances are posted against Opening Balance Adjustments on the inventory start date. */
export function postContactOpening(id: number) {
  const c = db().get<Row>('SELECT * FROM contacts WHERE id = ?', id)!;
  const date = org().inventory_start_date;
  const amt = r2(c.opening_balance);
  if (!amt) return replaceJournal('contact_opening', id, null);
  const party = c.kind === 'customer' ? acct('accounts_receivable') : acct('accounts_payable');
  const obe = acct('opening_balance_adjustments');
  replaceJournal('contact_opening', id, {
    date, memo: `Opening balance - ${c.name}`,
    lines: c.kind === 'customer'
      ? [{ account_id: party, debit: amt, contact_id: id }, { account_id: obe, credit: amt, contact_id: id }]
      : [{ account_id: party, credit: amt, contact_id: id }, { account_id: obe, debit: amt, contact_id: id }],
  });
}

export function contactBalance(id: number) {
  const c = db().get<Row>('SELECT kind FROM contacts WHERE id = ?', id);
  if (!c) return 0;
  const account = c.kind === 'customer' ? acct('accounts_receivable') : acct('accounts_payable');
  const raw = db().value<number>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE jl.account_id = ? AND jl.contact_id = ?`,
    account, id) ?? 0;
  return r2(c.kind === 'customer' ? raw : -raw);
}

export function listContacts(kind: string, q: Row) {
  const where = ['c.kind = ?'];
  const params: unknown[] = [kind];
  if (q.search) { where.push('(c.name LIKE ? OR c.company_name LIKE ? OR c.email LIKE ? OR c.gstin LIKE ?)'); params.push(...Array(4).fill(`%${q.search}%`)); }
  if (q.active !== 'all') where.push('c.is_active = 1');
  const rows = db().all<Row>(`SELECT c.* FROM contacts c WHERE ${where.join(' AND ')} ORDER BY c.name LIMIT 1000`, ...params);
  return rows.map((r) => ({ ...r, custom: json(r.custom, {}), balance: contactBalance(r.id) }));
}

export function getContact(id: number) {
  const d = db();
  const c = d.get<Row>('SELECT * FROM contacts WHERE id = ?', id) ?? fail('Contact not found', 404);
  const docs = d.all<Row>('SELECT id, type, number, date, due_date, status, total, balance FROM documents WHERE contact_id = ? ORDER BY date DESC, id DESC LIMIT 200', id);
  const payments = d.all<Row>('SELECT id, kind, number, date, amount, mode FROM payments WHERE contact_id = ? ORDER BY date DESC LIMIT 100', id);
  const unpaid = d.value<number>("SELECT COALESCE(SUM(balance),0) FROM documents WHERE contact_id = ? AND type IN ('invoice','bill') AND status IN ('open','partially_paid')", id) ?? 0;
  return { ...c, custom: json(c.custom, {}), balance: contactBalance(id), unpaid: r2(unpaid), documents: docs, payments };
}

export function deleteContact(id: number, user?: AuthUser) {
  const d = db();
  const c = d.get<Row>('SELECT * FROM contacts WHERE id = ?', id) ?? fail('Contact not found', 404);
  if (d.get('SELECT 1 FROM documents WHERE contact_id = ?', id) || d.get('SELECT 1 FROM payments WHERE contact_id = ?', id)) {
    fail('This contact has transactions. Mark it inactive instead.', 422);
  }
  d.tx(() => {
    replaceJournal('contact_opening', id, null);
    d.run('DELETE FROM contacts WHERE id = ?', id);
  });
  audit('contact', id, 'deleted', `${c.kind} ${c.name} deleted`, user);
}

/** Customer statement: running balance of invoices, credits and payments between two dates. */
export function contactStatement(id: number, from: string, to: string) {
  const d = db();
  const c = d.get<Row>('SELECT * FROM contacts WHERE id = ?', id) ?? fail('Contact not found', 404);
  const account = c.kind === 'customer' ? acct('accounts_receivable') : acct('accounts_payable');
  const sign = c.kind === 'customer' ? 1 : -1;
  const opening = r2(sign * (d.value<number>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit),0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE jl.account_id = ? AND jl.contact_id = ? AND j.date < ?`,
    account, id, from) ?? 0));
  let running = opening;
  const rows = d.all<Row>(
    `SELECT j.date, j.source_type, j.source_id, j.memo, j.reference, SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
     FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
     WHERE jl.account_id = ? AND jl.contact_id = ? AND j.date BETWEEN ? AND ? GROUP BY j.id ORDER BY j.date, j.id`, account, id, from, to)
    .map((r) => {
      const amt = r2(sign * (r.debit - r.credit));
      running = r2(running + amt);
      return { ...r, amount: amt, balance: running };
    });
  return { contact: c, from, to, opening, closing: running, rows };
}

// ---------------- Items ----------------

export function saveItem(input: Row, user?: AuthUser, id?: number) {
  return db().tx(() => {
    const d = db();
    const existing = id ? d.get<Row>('SELECT * FROM items WHERE id = ?', id) ?? fail('Item not found', 404) : null;
    const name = str(input.name) ?? fail('Item name is required', 422);
    const type = input.type ?? existing?.type ?? 'goods';
    if (!['goods', 'service'].includes(type)) fail('Item type must be goods or service', 422);
    const sku = str(input.sku);
    if (sku && d.get('SELECT 1 FROM items WHERE sku = ? AND id <> ?', sku, id ?? -1)) fail(`SKU ${sku} is already used`, 409);
    const hsn = str(input.hsn_code);
    if (hsn && !/^\d{4,8}$/.test(hsn)) fail(type === 'service' ? 'SAC must be 4-8 digits' : 'HSN code must be 4-8 digits', 422);
    const tax_preference = input.tax_preference ?? 'taxable';
    if (!['taxable', 'exempt', 'nil', 'non_gst'].includes(tax_preference)) fail('Invalid tax preference', 422);
    if (tax_preference === 'taxable' && input.tax_id && !d.get('SELECT 1 FROM taxes WHERE id = ?', input.tax_id)) fail('Tax not found', 422);
    const track = type === 'goods' && input.track_inventory !== false && input.track_inventory !== 0;
    const tracking = track ? input.tracking ?? existing?.tracking ?? 'none' : 'none';
    if (!['none', 'batch', 'serial'].includes(tracking)) fail('Invalid tracking mode', 422);
    if (existing && existing.tracking !== tracking && d.get('SELECT 1 FROM stock_moves WHERE item_id = ?', id)) fail('Tracking mode cannot change once the item has stock transactions', 422);
    if (existing && !!existing.track_inventory !== track && d.get("SELECT 1 FROM stock_moves WHERE item_id = ? AND source_type <> 'item_opening'", id)) {
      fail('Inventory tracking cannot change once the item has stock transactions', 422);
    }
    const opening: Row[] = track ? (input.opening_stock ?? json(existing?.opening_stock, [])) : [];
    for (const o of opening) {
      if (!d.get('SELECT 1 FROM warehouses WHERE id = ?', o.warehouse_id)) fail('Opening stock warehouse not found', 422);
      if (Number(o.qty) < 0 || Number(o.rate) < 0) fail('Opening stock quantity and rate cannot be negative', 422);
    }
    const accountOk = (aid: unknown) => !aid || d.get('SELECT 1 FROM accounts WHERE id = ?', aid);
    for (const k of ['sales_account_id', 'purchase_account_id', 'inventory_account_id']) if (!accountOk(input[k])) fail(`Invalid ${k.replace(/_id$/, '').replace(/_/g, ' ')}`, 422);
    const row = {
      sku, name, type, unit: str(input.unit) ?? 'pcs', hsn_code: hsn, tax_preference, tax_id: tax_preference === 'taxable' ? input.tax_id ?? null : null,
      sales_rate: r2(Number(input.sales_rate ?? 0)), purchase_rate: r2(Number(input.purchase_rate ?? 0)),
      sales_account_id: input.sales_account_id || acct(type === 'service' ? 'service_income' : 'sales'),
      purchase_account_id: input.purchase_account_id || (track ? acct('cogs') : acct('purchases')),
      inventory_account_id: track ? input.inventory_account_id || acct('inventory_asset') : null,
      track_inventory: track ? 1 : 0, tracking, reorder_level: Number(input.reorder_level ?? 0) || 0,
      preferred_vendor_id: input.preferred_vendor_id || null, opening_stock: JSON.stringify(opening),
      description: str(input.description), is_active: input.is_active === false ? 0 : 1,
      custom: JSON.stringify(input.custom ?? json(existing?.custom, {})), updated_at: new Date().toISOString(),
    };
    if (row.sales_rate < 0 || row.purchase_rate < 0) fail('Rates cannot be negative', 422);
    if (opening.some((o) => Number(o.qty) > 0)) assertUnlocked('inventory', org().inventory_start_date, 'opening stock');
    const iid = existing ? (d.update('items', existing.id, row), existing.id) : d.insert('items', row);
    if (input.opening_stock !== undefined || !existing) postItemOpening(iid);
    audit('item', iid, existing ? 'updated' : 'created', `Item ${name} ${existing ? 'updated' : 'created'}`, user);
    return iid;
  });
}

export function listItems(q: Row) {
  const where = ['1=1'];
  const params: unknown[] = [];
  if (q.search) { where.push('(i.name LIKE ? OR i.sku LIKE ? OR i.hsn_code LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`); }
  if (q.type) { where.push('i.type = ?'); params.push(q.type); }
  if (q.active !== 'all') where.push('i.is_active = 1');
  if (q.low_stock) where.push('i.track_inventory = 1 AND i.reorder_level > 0');
  const rows = db().all<Row>(
    `SELECT i.*, t.name AS tax_name, t.rate AS tax_rate,
       (SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = i.id AND physical = 1) AS stock_on_hand,
       (SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = i.id AND accounting = 1) AS accounting_stock,
       (SELECT COALESCE(SUM(value),0) FROM stock_moves WHERE item_id = i.id AND accounting = 1) AS stock_value
     FROM items i LEFT JOIN taxes t ON t.id = i.tax_id WHERE ${where.join(' AND ')} ORDER BY i.name LIMIT 2000`, ...params);
  const out = rows.map((r) => ({ ...r, custom: json(r.custom, {}), opening_stock: json(r.opening_stock, []), stock_on_hand: r2(r.stock_on_hand), accounting_stock: r2(r.accounting_stock), stock_value: r2(r.stock_value) }));
  return q.low_stock ? out.filter((r) => r.stock_on_hand <= r.reorder_level) : out;
}

export function getItem(id: number) {
  const d = db();
  const i = d.get<Row>('SELECT i.*, t.name AS tax_name, t.rate AS tax_rate FROM items i LEFT JOIN taxes t ON t.id = i.tax_id WHERE i.id = ?', id) ?? fail('Item not found', 404);
  const stock = i.track_inventory ? stockSummary(id) : null;
  const transactions = d.all<Row>(
    `SELECT m.date, m.kind, m.qty, m.value, m.physical, m.accounting, m.source_type, m.source_id, m.batch_no, m.serial_no, w.name AS warehouse_name,
            COALESCE(doc.number, mo.number, CASE WHEN m.source_type = 'item_opening' THEN 'Opening Stock' END) AS reference
     FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id
     LEFT JOIN documents doc ON doc.id = m.source_id AND doc.type = m.source_type
     LEFT JOIN manufacturing_orders mo ON mo.id = m.source_id AND m.source_type = 'mo'
     WHERE m.item_id = ? ORDER BY m.date DESC, m.id DESC LIMIT 300`, id);
  const warehouses = d.all<Row>('SELECT id FROM warehouses WHERE is_active = 1');
  const batches = i.tracking === 'batch' ? warehouses.flatMap((w) => availableBatches(id, w.id).map((b) => ({ ...b, warehouse_id: w.id }))) : [];
  const serials = i.tracking === 'serial' ? warehouses.flatMap((w) => availableSerials(id, w.id).map((s) => ({ serial_no: s, warehouse_id: w.id }))) : [];
  const boms = d.all<Row>('SELECT id, number, name, quantity FROM boms WHERE item_id = ?', id);
  const priceLists = d.all<Row>('SELECT pl.id, pl.name, pli.rate FROM price_list_items pli JOIN price_lists pl ON pl.id = pli.price_list_id WHERE pli.item_id = ?', id);
  return { ...i, custom: json(i.custom, {}), opening_stock: json(i.opening_stock, []), stock, transactions, batches, serials, boms, price_lists: priceLists };
}

export function deleteItem(id: number, user?: AuthUser) {
  const d = db();
  const i = d.get<Row>('SELECT * FROM items WHERE id = ?', id) ?? fail('Item not found', 404);
  if (d.get('SELECT 1 FROM document_lines WHERE item_id = ?', id) || d.get("SELECT 1 FROM stock_moves WHERE item_id = ? AND source_type <> 'item_opening'", id)
    || d.get('SELECT 1 FROM bom_components WHERE item_id = ?', id) || d.get('SELECT 1 FROM boms WHERE item_id = ?', id)) {
    fail('This item is used in transactions or BOMs. Mark it inactive instead.', 422);
  }
  d.tx(() => {
    d.run('DELETE FROM stock_moves WHERE item_id = ?', id);
    replaceJournal('item_opening', id, null);
    d.run('DELETE FROM quality_rules WHERE item_id = ?', id);
    d.run('DELETE FROM items WHERE id = ?', id);
  });
  audit('item', id, 'deleted', `Item ${i.name} deleted`, user);
}

/** Rate for an item after applying a price list (percentage markup/markdown or per-item rate). */
export function priceFor(itemId: number, priceListId?: number | null, side: 'sales' | 'purchase' = 'sales') {
  const d = db();
  const item = d.get<Row>('SELECT sales_rate, purchase_rate FROM items WHERE id = ?', itemId);
  if (!item) return 0;
  const base = side === 'sales' ? item.sales_rate : item.purchase_rate;
  if (!priceListId) return base;
  const pl = d.get<Row>('SELECT * FROM price_lists WHERE id = ? AND is_active = 1', priceListId);
  if (!pl) return base;
  if (pl.mode === 'per_item') return d.value<number>('SELECT rate FROM price_list_items WHERE price_list_id = ? AND item_id = ?', priceListId, itemId) ?? base;
  return r2(base * (1 + pl.percentage / 100));
}

// ---------------- Accounts ----------------

export function listAccounts(q: Row = {}) {
  const rows = db().all<Row>(`SELECT * FROM accounts ${q.active === 'all' ? '' : 'WHERE is_active = 1'} ORDER BY code, name`);
  return rows.map((a) => ({ ...a, category: categoryOf(a.type), type_label: ACCOUNT_TYPES[a.type]?.label, balance: accountBalance(a.id) }));
}

export function saveAccount(input: Row, user?: AuthUser, id?: number) {
  const d = db();
  const existing = id ? d.get<Row>('SELECT * FROM accounts WHERE id = ?', id) ?? fail('Account not found', 404) : null;
  const name = str(input.name) ?? fail('Account name is required', 422);
  const type = input.type ?? existing?.type;
  if (!ACCOUNT_TYPES[type]) fail('Invalid account type', 422);
  if (existing?.system_key && type !== existing.type) fail('The type of a system account cannot change', 422);
  if (existing && type !== existing.type && categoryOf(type) !== categoryOf(existing.type) && d.get('SELECT 1 FROM journal_lines WHERE account_id = ?', id)) {
    fail('Account category cannot change once it has transactions', 422);
  }
  const code = str(input.code);
  if (code && d.get('SELECT 1 FROM accounts WHERE code = ? AND id <> ?', code, id ?? -1)) fail(`Account code ${code} is already used`, 409);
  if (input.parent_id) {
    const p = d.get<Row>('SELECT * FROM accounts WHERE id = ?', input.parent_id) ?? fail('Parent account not found', 422);
    if (categoryOf(p.type) !== categoryOf(type)) fail('Parent account must be of the same category', 422);
    if (p.id === id) fail('An account cannot be its own parent', 422);
  }
  const row = {
    code, name, type, parent_id: input.parent_id || null, description: str(input.description),
    bank_name: str(input.bank_name), account_number: str(input.account_number), ifsc: str(input.ifsc)?.toUpperCase() ?? null,
    currency_code: input.currency_code ?? existing?.currency_code ?? 'INR', is_active: input.is_active === false ? 0 : 1,
  };
  if (row.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(row.ifsc)) fail('IFSC format is invalid', 422);
  if (existing?.system_key && !row.is_active) fail('System accounts cannot be deactivated', 422);
  const aid = existing ? (d.update('accounts', existing.id, row), existing.id) : d.insert('accounts', row);
  audit('account', aid, existing ? 'updated' : 'created', `Account ${name} ${existing ? 'updated' : 'created'}`, user);
  return aid;
}

export function deleteAccount(id: number, user?: AuthUser) {
  const d = db();
  const a = d.get<Row>('SELECT * FROM accounts WHERE id = ?', id) ?? fail('Account not found', 404);
  if (a.system_key) fail('System accounts cannot be deleted', 422);
  if (d.get('SELECT 1 FROM journal_lines WHERE account_id = ?', id)) fail('This account has transactions. Mark it inactive instead.', 422);
  if (d.get('SELECT 1 FROM accounts WHERE parent_id = ?', id)) fail('Move or delete the sub-accounts first', 422);
  if (d.get('SELECT 1 FROM items WHERE sales_account_id = ? OR purchase_account_id = ? OR inventory_account_id = ?', id, id, id)) fail('Items use this account', 422);
  d.run('DELETE FROM accounts WHERE id = ?', id);
  audit('account', id, 'deleted', `Account ${a.name} deleted`, user);
}

// ---------------- Simple masters ----------------

export function saveWarehouse(input: Row, id?: number) {
  const d = db();
  const name = str(input.name) ?? fail('Warehouse name is required', 422);
  if (input.gstin) {
    const err = validateGstin(input.gstin);
    if (err) fail(err, 422);
  }
  const row = { name, code: str(input.code), address: str(input.address), state_code: input.state_code || (input.gstin ? String(input.gstin).slice(0, 2) : null), gstin: str(input.gstin)?.toUpperCase() ?? null, is_active: input.is_active === false ? 0 : 1, is_primary: input.is_primary ? 1 : 0 };
  if (row.state_code && !STATES[row.state_code]) fail('Invalid state', 422);
  return d.tx(() => {
    if (row.is_primary) d.run('UPDATE warehouses SET is_primary = 0');
    if (id) {
      if (!row.is_active && d.value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE warehouse_id = ? AND physical = 1', id)) fail('Move the stock out before deactivating this warehouse', 422);
      d.update('warehouses', id, row);
      return id;
    }
    return d.insert('warehouses', row);
  });
}

export function saveTax(input: Row, id?: number) {
  const name = str(input.name) ?? fail('Tax name is required', 422);
  const rate = Number(input.rate);
  if (!(rate >= 0 && rate <= 100)) fail('Rate must be between 0 and 100', 422);
  const row = { name, rate, kind: 'gst', is_active: input.is_active === false ? 0 : 1 };
  if (id) {
    if (rate !== db().value<number>('SELECT rate FROM taxes WHERE id = ?', id) && db().get('SELECT 1 FROM document_lines WHERE tax_id = ?', id)) fail('The rate of a tax used in transactions cannot change. Create a new tax instead.', 422);
    db().update('taxes', id, row);
    return id;
  }
  return db().insert('taxes', row);
}

export function savePriceList(input: Row, id?: number) {
  const d = db();
  const name = str(input.name) ?? fail('Price list name is required', 422);
  const mode = input.mode === 'per_item' ? 'per_item' : 'percentage';
  const row = { name, kind: input.kind === 'purchase' ? 'purchase' : 'sales', mode, percentage: Number(input.percentage ?? 0) || 0, description: str(input.description), is_active: input.is_active === false ? 0 : 1 };
  if (row.percentage <= -100) fail('Markdown cannot be 100% or more', 422);
  return d.tx(() => {
    const pid = id ? (d.update('price_lists', id, row), id) : d.insert('price_lists', row);
    if (mode === 'per_item' && Array.isArray(input.items)) {
      d.run('DELETE FROM price_list_items WHERE price_list_id = ?', pid);
      for (const it of input.items) {
        if (!d.get('SELECT 1 FROM items WHERE id = ?', it.item_id)) fail('Item not found', 422);
        if (Number(it.rate) < 0) fail('Rate cannot be negative', 422);
        d.insert('price_list_items', { price_list_id: pid, item_id: it.item_id, rate: r2(Number(it.rate)) });
      }
    }
    return pid;
  });
}
