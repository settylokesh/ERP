import { randomBytes, timingSafeEqual } from 'node:crypto';
import { audit } from './activity.js';
import { assertPasswordStrength, DEFAULT_ROLES, hashPassword, loadUser } from './auth.js';
import { db, fail, openDb } from './db.js';
import { postOpeningJournal, repostJournal } from './documents/posting.js';
import { DOC_TYPES } from './documents/types.js';
import { setReposter } from './inventory.js';
import { acct, seedAccounts } from './ledger.js';
import { postMoJournal } from './manufacturing.js';
import { DEFAULT_COMPONENTS, DEFAULT_PT_SLABS } from './payroll.js';
import { migrate } from './migrations.js';
import { DEFAULT_ORG, DEFAULT_SEQUENCES, getKv, setKv, validateOrgProfile, type OrgSettings } from './settings.js';
import { fiscalYear, isEmail, pick, today } from './util.js';

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

/**
 * Idempotent base configuration every organisation needs: the chart of accounts, GST and TDS rates, the first
 * warehouse, numbering series, default roles, salary components, professional-tax slabs and fixed-asset types.
 * It never creates users or business data: the organisation profile and first administrator come from first-run setup
 * (the setup screen, or environment variables for unattended installs - see index.ts).
 */
export function bootstrap() {
  const d = db();
  registerHooks();
  migrate(d);
  d.tx(() => {
    seedAccounts();
    if (!d.get('SELECT 1 FROM currencies')) d.insert('currencies', { code: 'INR', name: 'Indian Rupee', symbol: '₹', rate: 1, is_base: 1 });
    if (!d.get('SELECT 1 FROM taxes')) for (const [name, rate, active] of TAXES) d.insert('taxes', { name, rate, is_active: active });
    if (!d.get('SELECT 1 FROM tds_sections')) for (const [section, name, rate] of TDS) d.insert('tds_sections', { section, name, rate });
    if (!d.get('SELECT 1 FROM warehouses')) d.insert('warehouses', { name: 'Primary Warehouse', code: 'WH-01', is_primary: 1, state_code: null });
    for (const [type, prefix] of Object.entries(DEFAULT_SEQUENCES)) {
      if (!d.get('SELECT 1 FROM sequences WHERE type = ?', type)) d.insert('sequences', { type, prefix, next_no: 1, padding: 5 });
    }
    if (!d.get('SELECT 1 FROM roles')) {
      for (const r of DEFAULT_ROLES) d.insert('roles', { name: r.name, description: r.description, is_admin: r.is_admin ? 1 : 0, permissions: JSON.stringify(r.permissions) });
    }
    if (!d.get('SELECT 1 FROM salary_components')) for (const c of DEFAULT_COMPONENTS) d.insert('salary_components', c);
    if (!d.get('SELECT 1 FROM pt_slabs')) for (const s of DEFAULT_PT_SLABS) d.insert('pt_slabs', s);
    if (!d.get("SELECT 1 FROM kv WHERE key = 'org'")) setKv('org', DEFAULT_ORG);
    if (!d.get('SELECT 1 FROM asset_types')) {
      // Useful lives follow Schedule II of the Companies Act, 2013 (plant 15 years, computers 3 years, furniture 10 years).
      d.insert('asset_types', { name: 'Plant and Machinery', asset_account_id: acct('machinery'), depreciation_account_id: acct('depreciation'), accumulated_account_id: acct('accumulated_depreciation'), method: 'slm', useful_life_months: 180, wdv_rate: 0 });
      d.insert('asset_types', { name: 'Computers', asset_account_id: acct('computers'), depreciation_account_id: acct('depreciation'), accumulated_account_id: acct('accumulated_depreciation'), method: 'slm', useful_life_months: 36, wdv_rate: 0 });
      d.insert('asset_types', { name: 'Furniture and Fixtures', asset_account_id: acct('furniture'), depreciation_account_id: acct('depreciation'), accumulated_account_id: acct('accumulated_depreciation'), method: 'wdv', useful_life_months: 120, wdv_rate: 25.89 });
    }
  });
  return getKv('org', DEFAULT_ORG);
}

export function initDatabase(file: string) {
  openDb(file);
  bootstrap();
  return db();
}

/** True until the first administrator exists. */
export const needsSetup = () => !db().get('SELECT 1 FROM users');

let setupCode: string | null = null;
/**
 * One-time code required by POST /api/setup, so that a freshly started server reachable from a network cannot be
 * claimed by whoever finds it first. It is printed to the server log at start-up; set SETUP_TOKEN to choose it.
 */
export function setupToken(): string {
  return (setupCode ??= process.env.SETUP_TOKEN || randomBytes(6).toString('hex').toUpperCase().replace(/(.{4})(?=.)/g, '$1-'));
}
export function checkSetupToken(given: unknown) {
  const a = Buffer.from(String(given ?? '').trim().toUpperCase());
  const b = Buffer.from(setupToken().toUpperCase());
  if (a.length !== b.length || !timingSafeEqual(a, b)) fail('The setup code is not correct. It is shown in the server log when the server starts.', 403);
}

function createAdmin(a: { name: string; email: string; password: string }) {
  const d = db();
  const email = String(a.email ?? '').trim().toLowerCase();
  if (!isEmail(email)) fail('A valid administrator email is required', 422);
  assertPasswordStrength(a.password);
  const adminRole = d.value<number>('SELECT id FROM roles WHERE is_admin = 1 ORDER BY id LIMIT 1') ?? fail('Admin role is missing', 500);
  return d.insert('users', { name: String(a.name ?? '').trim() || 'Administrator', email, password_hash: hashPassword(String(a.password)), role_id: adminRole });
}

export interface SetupInput {
  organisation: Partial<OrgSettings> & { name: string; state_code: string };
  admin: { name: string; email: string; password: string };
}

/**
 * First-run setup: records the organisation profile and creates the first administrator. Only allowed while no user
 * exists, so it cannot be used to take over an installed system.
 */
export function completeSetup(input: SetupInput) {
  const d = db();
  return d.tx(() => {
    if (!needsSetup()) fail('Setup has already been completed. Sign in instead.', 409);
    const o = input?.organisation ?? ({} as SetupInput['organisation']);
    const fyMonth = Number(o.fiscal_year_start_month ?? DEFAULT_ORG.fiscal_year_start_month);
    const next = validateOrgProfile({
      ...pick(o, ['name', 'legal_name', 'gstin', 'pan', 'state_code', 'address', 'city', 'pincode', 'email', 'phone', 'website', 'industry', 'valuation_method'] as (keyof OrgSettings)[]),
      fiscal_year_start_month: fyMonth,
      // Opening stock and balances default to the first day of the current financial year.
      inventory_start_date: o.inventory_start_date || (fyMonth >= 1 && fyMonth <= 12 ? fiscalYear(today(), fyMonth).start : ''),
      einvoice_enabled: !!o.einvoice_enabled,
      setup_complete: true,
    });
    const name = next.name;
    setKv('org', next);
    d.run('UPDATE warehouses SET state_code = ? WHERE is_primary = 1 AND state_code IS NULL', next.state_code);
    const userId = createAdmin(input.admin ?? ({} as SetupInput['admin']));
    audit('settings', null, 'setup', `Organisation ${name} set up`, loadUser(userId));
    return { org: next, user_id: userId };
  });
}
