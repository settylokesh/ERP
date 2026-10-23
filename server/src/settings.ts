import { db, fail, json } from './db.js';

export interface OrgSettings {
  name: string;
  legal_name: string;
  gstin: string;
  state_code: string;
  address: string;
  city: string;
  pincode: string;
  email: string;
  phone: string;
  pan: string;
  website: string;
  industry: string;
  base_currency: string;
  fiscal_year_start_month: number;
  inventory_start_date: string;
  valuation_method: 'fifo' | 'wac';
  prevent_negative_stock: boolean;
  einvoice_enabled: boolean;
  eway_threshold: number;
  b2cl_threshold: number;
  invoice_terms: string;
  invoice_notes: string;
  setup_complete: boolean;
}

export const DEFAULT_ORG: OrgSettings = {
  name: 'My Company',
  legal_name: 'My Company Private Limited',
  gstin: '',
  state_code: '29',
  address: '',
  city: '',
  pincode: '',
  email: '',
  phone: '',
  pan: '',
  website: '',
  industry: 'Manufacturing',
  base_currency: 'INR',
  fiscal_year_start_month: 4,
  inventory_start_date: '2026-04-01',
  valuation_method: 'fifo',
  prevent_negative_stock: true,
  einvoice_enabled: true,
  eway_threshold: 50000,
  // Since 1 Aug 2024 inter-state B2C invoices above Rs 1 lakh are reported as B2CL in GSTR-1.
  b2cl_threshold: 100000,
  invoice_terms: 'Goods once sold will not be taken back. Interest @18% p.a. will be charged on overdue invoices.',
  invoice_notes: 'Thank you for your business.',
  setup_complete: false,
};

/**
 * Statutory payroll parameters. Every value is editable in Settings > Payroll because these change by notification.
 * Defaults reflect public guidance as of Oct 2026: EPF 12%/12% (EPS 8.33% on wages up to Rs 15,000), EPF wage ceiling
 * raised from Rs 15,000 to Rs 25,000 w.e.f. 17 Sep 2026 (S.O. 5109(E), as reported by BDO/KPMG), ESI 0.75%/3.25% for
 * gross up to Rs 21,000, new-regime income tax slabs for FY 2026-27 (unchanged from FY 2025-26).
 */
export const DEFAULT_PAYROLL = {
  pay_day: 'last_working_day',
  basic_pct_of_ctc: 50,
  hra_pct_of_basic: 50,
  pf: {
    enabled: true,
    employee_rate: 12,
    employer_rate: 12,
    eps_rate: 8.33,
    eps_wage_cap: 15000,
    restrict_to_ceiling: true,
    wage_ceilings: [
      { from: '2014-09-01', amount: 15000 },
      { from: '2026-09-17', amount: 25000 },
    ],
    edli_rate: 0.5,
    admin_rate: 0.5,
    include_employer_in_ctc: true,
  },
  esi: { enabled: true, employee_rate: 0.75, employer_rate: 3.25, wage_limit: 21000 },
  pt: { enabled: true },
  tds: {
    enabled: true,
    regime: 'new',
    standard_deduction: 75000,
    slabs: [
      { upto: 400000, rate: 0 },
      { upto: 800000, rate: 5 },
      { upto: 1200000, rate: 10 },
      { upto: 1600000, rate: 15 },
      { upto: 2000000, rate: 20 },
      { upto: 2400000, rate: 25 },
      { upto: null, rate: 30 },
    ],
    rebate_income_limit: 1200000,
    rebate_max: 60000,
    cess_rate: 4,
  },
};
export type PayrollSettings = typeof DEFAULT_PAYROLL;

export const LOCK_MODULES = ['sales', 'purchases', 'banking', 'accountant', 'inventory', 'payroll'] as const;
export type LockModule = (typeof LOCK_MODULES)[number];

export function getKv<T>(key: string, fallback: T): T {
  const row = db().get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
  if (!row) return fallback;
  const v = json<any>(row.value, fallback);
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) return { ...fallback, ...v };
  return v;
}
export function setKv(key: string, value: unknown) {
  db().run('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

export const org = () => getKv<OrgSettings>('org', DEFAULT_ORG);
export const payrollSettings = (): PayrollSettings => {
  const v = getKv<PayrollSettings>('payroll', DEFAULT_PAYROLL);
  return { ...DEFAULT_PAYROLL, ...v, pf: { ...DEFAULT_PAYROLL.pf, ...v.pf }, esi: { ...DEFAULT_PAYROLL.esi, ...v.esi }, tds: { ...DEFAULT_PAYROLL.tds, ...v.tds } };
};
export const lockDates = () => getKv<Partial<Record<LockModule | 'all', string>>>('lock_dates', {});

export function assertUnlocked(module: LockModule, date: string, what = 'transaction') {
  const locks = lockDates();
  const lock = [locks[module], locks.all].filter(Boolean).sort().pop();
  if (lock && date <= lock) fail(`Transactions in ${module} dated on or before ${lock} are locked. You cannot create, edit or delete this ${what}.`, 423);
}

export const DEFAULT_SEQUENCES: Record<string, string> = {
  quote: 'QT-', sales_order: 'SO-', package: 'PKG-', invoice: 'INV-', credit_note: 'CN-', sales_return: 'RMA-',
  delivery_challan: 'DC-', retainer_invoice: 'RET-', purchase_request: 'PR-', rfq: 'RFQ-', purchase_order: 'PO-',
  purchase_receive: 'GRN-', bill: 'BILL-', vendor_credit: 'VC-', expense: 'EXP-', transfer_order: 'TO-',
  inventory_adjustment: 'ADJ-', stock_count: 'SC-', payment_received: 'PAY-', payment_made: 'PM-', journal: 'MJ-',
  bom: 'BOM-', manufacturing_order: 'MO-', job_card: 'JC-', inspection: 'QI-', asset: 'FA-', pay_run: 'PRUN-',
  bank_txn: 'BT-', refund: 'RF-',
};

export function nextNumber(type: string): string {
  const d = db();
  let row = d.get<{ prefix: string; next_no: number; padding: number }>('SELECT * FROM sequences WHERE type = ?', type);
  if (!row) {
    d.insert('sequences', { type, prefix: DEFAULT_SEQUENCES[type] ?? `${type.toUpperCase().slice(0, 3)}-`, next_no: 1, padding: 5 });
    row = d.get('SELECT * FROM sequences WHERE type = ?', type)!;
  }
  d.run('UPDATE sequences SET next_no = next_no + 1 WHERE type = ?', type);
  return `${row.prefix}${String(row.next_no).padStart(row.padding, '0')}`;
}
export function peekNumber(type: string): string {
  const row = db().get<{ prefix: string; next_no: number; padding: number }>('SELECT * FROM sequences WHERE type = ?', type);
  if (!row) return `${DEFAULT_SEQUENCES[type] ?? ''}00001`;
  return `${row.prefix}${String(row.next_no).padStart(row.padding, '0')}`;
}
