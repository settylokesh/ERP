import { DEFAULT_ROLES, hashPassword } from './auth.js';
import { db, openDb, type Row } from './db.js';
import { postOpeningJournal, repostJournal } from './documents/posting.js';
import { DOC_TYPES } from './documents/types.js';
import { setReposter } from './inventory.js';
import { acct, seedAccounts } from './ledger.js';
import { postMoJournal } from './manufacturing.js';
import { DEFAULT_COMPONENTS, DEFAULT_PT_SLABS } from './payroll.js';
import { DEFAULT_ORG, DEFAULT_SEQUENCES, getKv, setKv } from './settings.js';
import { makeGstin } from './util.js';

/** Wires the inventory revaluation callback to the journal builders. */
export function registerHooks() {
  setReposter((type, id) => {
    if (DOC_TYPES[type]) repostJournal(type, id);
    else if (type === 'mo') postMoJournal(id);
    else if (type === 'item_opening') postOpeningJournal(id);
  });
}

/**
 * GST rates after the GST 2.0 rationalisation (w.e.f. 22 Sep 2025): 0%, 5%, 18% and 40% slabs, plus 3% (gold/silver)
 * and 0.25% (rough diamonds). 12% and 28% are kept inactive for documents dated before the change.
 */
const TAXES: [string, number, number][] = [
  ['GST 0%', 0, 1], ['GST 0.25%', 0.25, 1], ['GST 3%', 3, 1], ['GST 5%', 5, 1], ['GST 18%', 18, 1], ['GST 40%', 40, 1],
  ['GST 12% (before 22-Sep-2025)', 12, 0], ['GST 28% (before 22-Sep-2025)', 28, 0],
];
/** Common TDS sections for vendor payments (Income-tax Act, 1961 numbering). Rates are editable. */
const TDS: [string, string, number][] = [
  ['194C', 'Payment to contractors - Individual/HUF', 1], ['194C', 'Payment to contractors - Others', 2],
  ['194J', 'Fees for professional services', 10], ['194J', 'Fees for technical services', 2],
  ['194I', 'Rent - Land, building or furniture', 10], ['194I', 'Rent - Plant and machinery', 2],
  ['194H', 'Commission or brokerage', 2], ['194Q', 'Purchase of goods', 0.1],
];

/** Idempotent base configuration every organisation needs. */
export function bootstrap(opts: { adminEmail?: string; adminPassword?: string; orgName?: string } = {}) {
  const d = db();
  registerHooks();
  d.tx(() => {
    seedAccounts();
    if (!d.get('SELECT 1 FROM currencies')) {
      // Foreign currency rates are placeholders - maintain them in Settings > Currencies before use.
      for (const [code, name, symbol, rate, base] of [['INR', 'Indian Rupee', '₹', 1, 1], ['USD', 'US Dollar', '$', 88, 0], ['EUR', 'Euro', '€', 102, 0], ['GBP', 'Pound Sterling', '£', 117, 0], ['AED', 'UAE Dirham', 'AED', 24, 0]] as const) {
        d.insert('currencies', { code, name, symbol, rate, is_base: base });
      }
    }
    if (!d.get('SELECT 1 FROM taxes')) for (const [name, rate, active] of TAXES) d.insert('taxes', { name, rate, is_active: active });
    if (!d.get('SELECT 1 FROM tds_sections')) for (const [section, name, rate] of TDS) d.insert('tds_sections', { section, name, rate });
    if (!d.get('SELECT 1 FROM warehouses')) d.insert('warehouses', { name: 'Primary Warehouse', code: 'WH-01', is_primary: 1, state_code: null });
    for (const [type, prefix] of Object.entries(DEFAULT_SEQUENCES)) {
      if (!d.get('SELECT 1 FROM sequences WHERE type = ?', type)) d.insert('sequences', { type, prefix, next_no: 1, padding: 5 });
    }
    if (!d.get('SELECT 1 FROM roles')) {
      for (const r of DEFAULT_ROLES) d.insert('roles', { name: r.name, description: r.description, is_admin: r.is_admin ? 1 : 0, permissions: JSON.stringify(r.permissions) });
    }
    if (!d.get('SELECT 1 FROM users')) {
      const adminRole = d.value<number>('SELECT id FROM roles WHERE is_admin = 1 LIMIT 1');
      d.insert('users', { name: 'Administrator', email: opts.adminEmail ?? 'admin@saral.local', password_hash: hashPassword(opts.adminPassword ?? 'admin123'), role_id: adminRole });
    }
    if (!d.get('SELECT 1 FROM salary_components')) for (const c of DEFAULT_COMPONENTS) d.insert('salary_components', c);
    if (!d.get('SELECT 1 FROM pt_slabs')) for (const s of DEFAULT_PT_SLABS) d.insert('pt_slabs', s);
    if (!d.get("SELECT 1 FROM kv WHERE key = 'org'")) setKv('org', { ...DEFAULT_ORG, name: opts.orgName ?? DEFAULT_ORG.name });
    if (!d.get('SELECT 1 FROM asset_types')) {
      d.insert('asset_types', { name: 'Plant and Machinery', asset_account_id: acct('machinery'), depreciation_account_id: acct('depreciation'), accumulated_account_id: acct('accumulated_depreciation'), method: 'slm', useful_life_months: 180, wdv_rate: 0 });
      d.insert('asset_types', { name: 'Computers', asset_account_id: acct('computers'), depreciation_account_id: acct('depreciation'), accumulated_account_id: acct('accumulated_depreciation'), method: 'slm', useful_life_months: 36, wdv_rate: 0 });
      d.insert('asset_types', { name: 'Furniture and Fixtures', asset_account_id: acct('furniture'), depreciation_account_id: acct('depreciation'), accumulated_account_id: acct('accumulated_depreciation'), method: 'wdv', useful_life_months: 120, wdv_rate: 25.89 });
    }
    for (const n of ['Production', 'Sales', 'Accounts', 'Stores', 'Human Resources']) if (!d.get('SELECT 1 FROM departments WHERE name = ?', n)) d.insert('departments', { name: n });
    for (const n of ['Machine Operator', 'Production Supervisor', 'Sales Executive', 'Accountant', 'Store Keeper', 'HR Executive']) if (!d.get('SELECT 1 FROM designations WHERE name = ?', n)) d.insert('designations', { name: n });
  });
  return getKv('org', DEFAULT_ORG);
}

export function initDatabase(file: string, opts: Parameters<typeof bootstrap>[0] = {}) {
  openDb(file);
  bootstrap(opts);
  return db();
}

export const DEMO_ORG = {
  name: 'Kaveri Pumps & Motors',
  legal_name: 'Kaveri Pumps and Motors Private Limited',
  gstin: makeGstin('29', 'AAKCK4821F'),
  pan: 'AAKCK4821F',
  state_code: '29',
  address: 'Plot 42, Peenya Industrial Area, 2nd Stage',
  city: 'Bengaluru',
  pincode: '560058',
  email: 'accounts@kaveripumps.example',
  phone: '+91 80 4123 4567',
  website: 'kaveripumps.example',
  industry: 'Manufacturing',
  setup_complete: true,
};

export function demoRows(): Row {
  return {
    customers: [
      { name: 'Sri Lakshmi Agro Traders', company_name: 'Sri Lakshmi Agro Traders', gst_treatment: 'business_gst', gstin: makeGstin('29', 'ABVPL7231K'), email: 'purchase@srilakshmi.example', phone: '9845012345', payment_terms: 30, billing_address: 'APMC Yard, Yeshwanthpur, Bengaluru 560022' },
      { name: 'Mehta Engineering Works', company_name: 'Mehta Engineering Works', gst_treatment: 'business_gst', gstin: makeGstin('27', 'AAFFM5512Q'), email: 'stores@mehtaeng.example', phone: '9820098200', payment_terms: 45, billing_address: 'MIDC Bhosari, Pune 411026' },
      { name: 'Coastal Irrigation LLP', company_name: 'Coastal Irrigation LLP', gst_treatment: 'business_gst', gstin: makeGstin('32', 'AALFC3091B'), email: 'ap@coastal.example', phone: '9447012340', payment_terms: 30, billing_address: 'Kakkanad, Kochi 682030' },
      { name: 'Ramesh Kumar', gst_treatment: 'consumer', place_of_supply: '29', email: 'ramesh.k@example.com', phone: '9900112233', payment_terms: 0, billing_address: 'Jayanagar 4th Block, Bengaluru' },
      { name: 'Nile Water Solutions', company_name: 'Nile Water Solutions FZE', gst_treatment: 'overseas', currency_code: 'USD', email: 'buying@nilewater.example', payment_terms: 60, billing_address: 'Jebel Ali Free Zone, Dubai, UAE' },
    ],
    vendors: [
      { name: 'Deccan Steel Suppliers', gst_treatment: 'business_gst', gstin: makeGstin('29', 'AADFD6610M'), email: 'sales@deccansteel.example', phone: '9886011122', payment_terms: 30 },
      { name: 'Ganga Electricals', gst_treatment: 'business_gst', gstin: makeGstin('09', 'AAGFG2290H'), email: 'orders@gangaelec.example', phone: '9415022233', payment_terms: 30 },
      { name: 'Swift Road Carriers', gst_treatment: 'business_gst', gstin: makeGstin('29', 'ABJFS1180D'), email: 'billing@swiftroad.example', phone: '9845500011', payment_terms: 15 },
      { name: 'Peenya Estates', gst_treatment: 'business_gst', gstin: makeGstin('29', 'AAEFP4410L'), email: 'rent@peenyaestates.example', phone: '9845700022', payment_terms: 7 },
      { name: 'Precision Bearings Co', gst_treatment: 'business_gst', gstin: makeGstin('33', 'AAHFP7745N'), email: 'sales@precisionbearings.example', phone: '9443033344', payment_terms: 30 },
    ],
  };
}
