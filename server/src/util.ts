export const round = (n: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
};
export const r2 = (n: number) => round(n, 2);
export const r4 = (n: number) => round(n, 4);
export const sum = (xs: number[]) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
export const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : d;
};

export const today = () => new Date().toISOString().slice(0, 10);
export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
export const addDays = (date: string, days: number) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const addMonths = (date: string, months: number) => {
  const d = new Date(date + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
export const monthEnd = (date: string) => {
  const d = new Date(date + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};
export const daysInMonth = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Fiscal year containing `date` given the starting month (1-12). Returns start/end ISO dates. */
export function fiscalYear(date: string, startMonth = 4) {
  const [y, m] = date.split('-').map(Number);
  const startYear = m >= startMonth ? y : y - 1;
  const start = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
  const end = addDays(addMonths(start, 12), -1);
  return { start, end, label: startMonth === 1 ? `${startYear}` : `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}` };
}

/** GST state codes as used on GSTINs and e-invoices. */
export const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory', '96': 'Foreign Country',
};

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** GSTIN check digit (mod-36 weighted algorithm used by GSTN). */
export function gstinCheckDigit(first14: string): string {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const v = GST_CHARS.indexOf(first14[i]);
    const p = v * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(p / 36) + (p % 36);
  }
  return GST_CHARS[(36 - (total % 36)) % 36];
}
export function validateGstin(g: string | null | undefined): string | null {
  if (!g) return 'GSTIN is required';
  const s = g.toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)) return 'GSTIN format is invalid';
  if (!STATES[s.slice(0, 2)]) return 'GSTIN state code is invalid';
  if (gstinCheckDigit(s.slice(0, 14)) !== s[14]) return 'GSTIN check digit is invalid';
  return null;
}
export const makeGstin = (state: string, pan: string, entity = '1') => {
  const base = `${state}${pan}${entity}Z`;
  return base + gstinCheckDigit(base);
};

export const GST_TREATMENTS: Record<string, string> = {
  business_gst: 'Registered Business - Regular',
  business_composition: 'Registered Business - Composition',
  business_none: 'Unregistered Business',
  consumer: 'Consumer',
  overseas: 'Overseas',
  sez: 'Special Economic Zone',
  deemed_export: 'Deemed Export',
};
export const isRegistered = (t?: string | null) => t === 'business_gst' || t === 'business_composition' || t === 'sez' || t === 'deemed_export';

export function amountInWords(n: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x: number) => (x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]}${x % 10 ? ' ' + ones[x % 10] : ''}`);
  const three = (x: number) => {
    const h = Math.floor(x / 100), r = x % 100;
    return [h ? `${ones[h]} Hundred` : '', r ? two(r) : ''].filter(Boolean).join(' ');
  };
  const inWords = (x: number): string => {
    if (x === 0) return 'Zero';
    const parts: string[] = [];
    const crore = Math.floor(x / 1e7); x %= 1e7;
    const lakh = Math.floor(x / 1e5); x %= 1e5;
    const thousand = Math.floor(x / 1e3); x %= 1e3;
    if (crore) parts.push(`${inWords(crore)} Crore`);
    if (lakh) parts.push(`${two(lakh)} Lakh`);
    if (thousand) parts.push(`${two(thousand)} Thousand`);
    if (x) parts.push(three(x));
    return parts.join(' ');
  };
  const abs = Math.abs(r2(n));
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);
  return `Indian Rupee ${inWords(rupees)}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
}

export const pick = <T extends object, K extends keyof T>(o: T, keys: K[]): Pick<T, K> => {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (k in o) out[k] = o[k];
  return out;
};
