import { audit } from './activity.js';
import type { AuthUser } from './auth.js';
import { db, fail, json, type Row } from './db.js';
import { acct, journalsFor, replaceJournal, type JLine } from './ledger.js';
import { assertUnlocked, nextNumber, org, payrollSettings, type PayrollSettings } from './settings.js';
import { daysInMonth, fiscalYear, isDate, monthEnd, r2, STATES } from './util.js';

export const DEFAULT_COMPONENTS = [
  { code: 'BASIC', name: 'Basic', kind: 'earning', calc: 'pct_ctc', value: 50, pf_applicable: 1, esi_applicable: 1, sort: 1 },
  { code: 'HRA', name: 'House Rent Allowance', kind: 'earning', calc: 'pct_basic', value: 50, pf_applicable: 0, esi_applicable: 1, sort: 2 },
  { code: 'CONV', name: 'Conveyance Allowance', kind: 'earning', calc: 'fixed', value: 0, pf_applicable: 0, esi_applicable: 1, sort: 3 },
  { code: 'SPECIAL', name: 'Fixed Allowance', kind: 'earning', calc: 'balance', value: 0, pf_applicable: 0, esi_applicable: 1, sort: 9 },
];

/** Karnataka PT (Amendment Act 2025, w.e.f. 1 Apr 2025): Rs 200/month at Rs 25,000+, Rs 300 in February. */
export const DEFAULT_PT_SLABS = [
  { state_code: '29', min_salary: 0, max_salary: 24999.99, amount: 0, feb_amount: 0 },
  { state_code: '29', min_salary: 25000, max_salary: null, amount: 200, feb_amount: 300 },
];

export function saveEmployee(input: Row, user?: AuthUser, id?: number) {
  const d = db();
  const name = String(input.name ?? '').trim() || fail('Employee name is required', 422);
  const emp_code = String(input.emp_code ?? '').trim() || fail('Employee ID is required', 422);
  if (d.get('SELECT 1 FROM employees WHERE emp_code = ? AND id <> ?', emp_code, id ?? -1)) fail(`Employee ID ${emp_code} is already used`, 409);
  const doj = input.doj;
  if (!isDate(doj)) fail('Date of joining is required', 422);
  if (input.exit_date && (!isDate(input.exit_date) || input.exit_date < doj)) fail('Exit date must be after the joining date', 422);
  const pan = input.pan ? String(input.pan).toUpperCase() : null;
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) fail('PAN format is invalid', 422);
  if (input.uan && !/^\d{12}$/.test(String(input.uan))) fail('UAN must be 12 digits', 422);
  if (input.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(input.ifsc).toUpperCase())) fail('IFSC format is invalid', 422);
  const work_state = input.work_state ?? org().state_code;
  if (!STATES[work_state]) fail('Work location state is invalid', 422);
  const annual_ctc = r2(Number(input.annual_ctc));
  if (!(annual_ctc >= 0)) fail('Annual CTC is invalid', 422);
  const row = {
    emp_code, name, email: input.email ?? null, phone: input.phone ?? null, gender: input.gender ?? null, dob: input.dob || null, doj,
    exit_date: input.exit_date || null, department_id: input.department_id || null, designation_id: input.designation_id || null, work_state, pan,
    uan: input.uan ?? null, esi_number: input.esi_number ?? null, bank_name: input.bank_name ?? null, bank_account: input.bank_account ?? null,
    ifsc: input.ifsc ? String(input.ifsc).toUpperCase() : null, annual_ctc, components: JSON.stringify(input.components ?? {}),
    pf_enabled: input.pf_enabled === false ? 0 : 1, esi_enabled: input.esi_enabled === false ? 0 : 1, pt_enabled: input.pt_enabled === false ? 0 : 1,
    tds_enabled: input.tds_enabled === false ? 0 : 1, status: input.exit_date ? 'exited' : input.status === 'inactive' ? 'inactive' : 'active',
  };
  structure({ ...row, components: row.components }, payrollSettings(), row.doj); // validates the CTC split
  const eid = id ? (d.update('employees', id, row), id) : d.insert('employees', row);
  audit('employee', eid, id ? 'updated' : 'created', `Employee ${name}`, user);
  return eid;
}

const pfCeiling = (s: PayrollSettings, date: string) =>
  [...s.pf.wage_ceilings].sort((a, b) => a.from.localeCompare(b.from)).filter((c) => c.from <= date).pop()?.amount ?? 15000;

/** Monthly salary structure (full month) derived from annual CTC. */
export function structure(emp: Row, s: PayrollSettings, onDate: string) {
  const d = db();
  const comps = d.all<Row>("SELECT * FROM salary_components WHERE is_active = 1 AND kind = 'earning' ORDER BY sort, id");
  const overrides = json<Row>(emp.components, {});
  const monthlyCtc = r2(emp.annual_ctc / 12);
  const earnings: Row[] = [];
  let basic = 0;
  for (const c of comps.filter((c) => c.calc === 'pct_ctc')) {
    const amt = r2(overrides[c.code] ?? monthlyCtc * c.value / 100);
    if (c.code === 'BASIC') basic = amt;
    earnings.push({ ...c, amount: amt });
  }
  for (const c of comps.filter((c) => c.calc === 'pct_basic')) earnings.push({ ...c, amount: r2(overrides[c.code] ?? basic * c.value / 100) });
  for (const c of comps.filter((c) => c.calc === 'fixed')) {
    const amt = r2(overrides[c.code] ?? c.value);
    if (amt) earnings.push({ ...c, amount: amt });
  }
  const ceiling = pfCeiling(s, onDate);
  const pfWageFull = earnings.filter((e) => e.pf_applicable).reduce((a, e) => a + e.amount, 0);
  const pfWage = s.pf.restrict_to_ceiling ? Math.min(pfWageFull, ceiling) : pfWageFull;
  const erPf = emp.pf_enabled && s.pf.enabled && s.pf.include_employer_in_ctc ? Math.round(pfWage * s.pf.employer_rate / 100) : 0;
  const fixedSoFar = earnings.reduce((a, e) => a + e.amount, 0);
  const balanceComp = comps.find((c) => c.calc === 'balance');
  let gross = monthlyCtc - erPf;
  let esiApplies = false;
  if (emp.esi_enabled && s.esi.enabled) {
    const g = gross / (1 + s.esi.employer_rate / 100);
    if (g <= s.esi.wage_limit) { gross = g; esiApplies = true; }
  }
  gross = r2(gross);
  if (balanceComp) {
    const bal = r2(gross - fixedSoFar);
    if (bal < -0.005) fail(`CTC of ₹${emp.annual_ctc} is too low for the configured salary components (short by ₹${r2(-bal)}/month)`, 422);
    if (bal > 0) earnings.push({ ...balanceComp, amount: bal });
  }
  return { monthlyCtc, earnings, gross: r2(earnings.reduce((a, e) => a + e.amount, 0)), esiApplies, ceiling };
}

function ptFor(state: string, gross: number, period: string): number {
  const slab = db().get<Row>('SELECT * FROM pt_slabs WHERE state_code = ? AND min_salary <= ? AND (max_salary IS NULL OR max_salary >= ?) ORDER BY min_salary DESC LIMIT 1', state, gross, gross);
  if (!slab) return 0;
  return period.endsWith('-02') && slab.feb_amount != null ? slab.feb_amount : slab.amount;
}

/** Annual income tax under the configured (new) regime, including the Section 87A rebate, marginal relief and 4% cess. */
export function annualTax(taxableIncome: number, s: PayrollSettings): number {
  const t = s.tds;
  let tax = 0, prev = 0;
  for (const slab of t.slabs) {
    const upto = slab.upto ?? Infinity;
    if (taxableIncome > prev) tax += (Math.min(taxableIncome, upto) - prev) * slab.rate / 100;
    prev = upto;
    if (taxableIncome <= upto) break;
  }
  if (taxableIncome <= t.rebate_income_limit) tax = Math.max(0, tax - Math.min(tax, t.rebate_max));
  else tax = Math.min(tax, taxableIncome - t.rebate_income_limit); // marginal relief just above the rebate limit
  let surcharge = 0;
  if (taxableIncome > 50000000) surcharge = tax * 0.25;
  else if (taxableIncome > 20000000) surcharge = tax * 0.25;
  else if (taxableIncome > 10000000) surcharge = tax * 0.15;
  else if (taxableIncome > 5000000) surcharge = tax * 0.10;
  return Math.round((tax + surcharge) * (1 + t.cess_rate / 100));
}

export function computePayslip(emp: Row, period: string, lopDays: number, s: PayrollSettings, excludeRunId?: number) {
  const days = daysInMonth(period);
  const start = `${period}-01`, end = monthEnd(start);
  let workingDays = days;
  if (emp.doj > start) workingDays -= Number(emp.doj.slice(8, 10)) - 1;
  if (emp.exit_date && emp.exit_date < end) workingDays -= days - Number(emp.exit_date.slice(8, 10));
  if (lopDays < 0 || lopDays > workingDays) fail(`Loss of pay days for ${emp.name} must be between 0 and ${workingDays}`, 422);
  const paidDays = r2(workingDays - lopDays);
  const factor = paidDays / days;
  const st = structure(emp, s, end);
  const earnings = st.earnings.map((e) => ({ code: e.code, name: e.name, amount: r2(e.amount * factor), pf: !!e.pf_applicable }));
  const gross = r2(earnings.reduce((a, e) => a + e.amount, 0));
  const deductions: Row[] = [];
  const employer: Row[] = [];
  if (emp.pf_enabled && s.pf.enabled) {
    const pfWageEarned = earnings.filter((e) => e.pf).reduce((a, e) => a + e.amount, 0);
    const pfWage = s.pf.restrict_to_ceiling ? Math.min(pfWageEarned, st.ceiling) : pfWageEarned;
    const ee = Math.round(pfWage * s.pf.employee_rate / 100);
    const erTotal = Math.round(pfWage * s.pf.employer_rate / 100);
    const eps = Math.min(Math.round(Math.min(pfWage, s.pf.eps_wage_cap) * s.pf.eps_rate / 100), erTotal);
    deductions.push({ code: 'EPF_EE', name: 'EPF Employee Contribution', amount: ee });
    employer.push({ code: 'EPF_ER', name: 'EPF Employer Contribution', amount: erTotal - eps });
    employer.push({ code: 'EPS', name: 'EPS Contribution', amount: eps });
    employer.push({ code: 'EDLI', name: 'EDLI Contribution', amount: Math.round(Math.min(pfWage, st.ceiling) * s.pf.edli_rate / 100) });
    employer.push({ code: 'PF_ADMIN', name: 'EPF Admin Charges', amount: Math.round(pfWage * s.pf.admin_rate / 100) });
  }
  if (st.esiApplies && gross > 0) {
    deductions.push({ code: 'ESI_EE', name: 'ESI Employee Contribution', amount: Math.ceil(r2(gross * s.esi.employee_rate / 100)) });
    employer.push({ code: 'ESI_ER', name: 'ESI Employer Contribution', amount: Math.ceil(r2(gross * s.esi.employer_rate / 100)) });
  }
  if (emp.pt_enabled && s.pt.enabled) {
    const pt = ptFor(emp.work_state, gross, period);
    if (pt) deductions.push({ code: 'PT', name: 'Professional Tax', amount: pt });
  }
  if (emp.tds_enabled && s.tds.enabled) {
    const fy = fiscalYear(start, 4);
    const annualGross = st.gross * 12;
    const taxable = Math.max(0, annualGross - s.tds.standard_deduction);
    const tax = annualTax(taxable, s);
    const deducted = db().value<number>(
      `SELECT COALESCE(SUM(json_extract(p.extra, '$.tds')),0) FROM payslips p JOIN pay_runs r ON r.id = p.pay_run_id
       WHERE p.employee_id = ? AND r.period >= ? AND r.period < ? AND r.id <> ?`, emp.id, fy.start.slice(0, 7), period, excludeRunId ?? -1) ?? 0;
    const [ey, em] = fy.end.split('-').map(Number);
    const [py, pm] = period.split('-').map(Number);
    const remaining = (ey - py) * 12 + (em - pm) + 1;
    const tds = Math.max(0, Math.round((tax - deducted) / Math.max(1, remaining)));
    if (tds) deductions.push({ code: 'TDS', name: 'Income Tax (TDS)', amount: tds });
  }
  const totalDed = r2(deductions.reduce((a, x) => a + x.amount, 0));
  const employerCost = r2(employer.reduce((a, x) => a + x.amount, 0));
  const get = (arr: Row[], c: string) => arr.find((x) => x.code === c)?.amount ?? 0;
  return {
    days, lop_days: lopDays, paid_days: paidDays, earnings, deductions, employer, gross, total_deductions: totalDed,
    net: r2(gross - totalDed), employer_cost: employerCost,
    extra: { tds: get(deductions, 'TDS'), pf_ee: get(deductions, 'EPF_EE'), esi_ee: get(deductions, 'ESI_EE'), pt: get(deductions, 'PT'), ctc_monthly: st.monthlyCtc },
  };
}

function eligibleEmployees(period: string) {
  const start = `${period}-01`, end = monthEnd(start);
  return db().all<Row>("SELECT * FROM employees WHERE status <> 'inactive' AND doj <= ? AND (exit_date IS NULL OR exit_date >= ?) ORDER BY emp_code", end, start);
}

export function createPayRun(input: Row, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const period = String(input.period ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail('Pay period must be YYYY-MM', 422);
    if (d.get('SELECT 1 FROM pay_runs WHERE period = ?', period)) fail(`A pay run for ${period} already exists`, 409);
    const prevDraft = d.get<Row>("SELECT period FROM pay_runs WHERE status = 'draft' AND period < ?", period);
    if (prevDraft) fail(`Approve the ${prevDraft.period} pay run first`, 422);
    const pay_date = input.pay_date ?? monthEnd(`${period}-01`);
    if (!isDate(pay_date)) fail('Pay date is invalid', 422);
    const emps = eligibleEmployees(period);
    if (!emps.length) fail('No active employees for this period', 422);
    const id = d.insert('pay_runs', { number: nextNumber('pay_run'), period, pay_date, status: 'draft' });
    const s = payrollSettings();
    for (const e of emps) {
      const p = computePayslip(e, period, 0, s, id);
      d.insert('payslips', { pay_run_id: id, employee_id: e.id, ...p, earnings: JSON.stringify(p.earnings), deductions: JSON.stringify(p.deductions), employer: JSON.stringify(p.employer), extra: JSON.stringify(p.extra) });
    }
    audit('pay_run', id, 'created', `Pay run for ${period} created with ${emps.length} employees`, user);
    return id;
  });
}

export function updatePayslip(payslipId: number, input: Row, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const ps = d.get<Row>('SELECT * FROM payslips WHERE id = ?', payslipId) ?? fail('Payslip not found', 404);
    const run = d.get<Row>('SELECT * FROM pay_runs WHERE id = ?', ps.pay_run_id)!;
    if (run.status !== 'draft') fail('Only draft pay runs can be changed', 422);
    const emp = d.get<Row>('SELECT * FROM employees WHERE id = ?', ps.employee_id)!;
    const lop = Number(input.lop_days ?? ps.lop_days);
    const p = computePayslip(emp, run.period, lop, payrollSettings(), run.id);
    d.update('payslips', payslipId, { ...p, earnings: JSON.stringify(p.earnings), deductions: JSON.stringify(p.deductions), employer: JSON.stringify(p.employer), extra: JSON.stringify(p.extra), withheld: input.withheld == null ? ps.withheld : input.withheld ? 1 : 0 });
    audit('pay_run', run.id, 'payslip', `Payslip of ${emp.name} updated (LOP ${lop})`, user);
  });
}

export function recalculatePayRun(id: number) {
  const d = db();
  const run = d.get<Row>('SELECT * FROM pay_runs WHERE id = ?', id) ?? fail('Pay run not found', 404);
  if (run.status !== 'draft') fail('Only draft pay runs can be recalculated', 422);
  d.tx(() => { for (const ps of d.all<Row>('SELECT id FROM payslips WHERE pay_run_id = ?', id)) updatePayslip(ps.id, {}); });
}

function payRunTotals(id: number) {
  const slips = db().all<Row>('SELECT * FROM payslips WHERE pay_run_id = ?', id);
  const sumCode = (field: 'deductions' | 'employer', codes: string[]) => r2(slips.reduce((a, s) => a + json<Row[]>(s[field], []).filter((x) => codes.includes(x.code)).reduce((b, x) => b + x.amount, 0), 0));
  return {
    employees: slips.length,
    gross: r2(slips.reduce((a, s) => a + s.gross, 0)),
    net: r2(slips.reduce((a, s) => a + s.net, 0)),
    net_payable: r2(slips.filter((s) => !s.withheld).reduce((a, s) => a + s.net, 0)),
    withheld: r2(slips.filter((s) => s.withheld).reduce((a, s) => a + s.net, 0)),
    pf_ee: sumCode('deductions', ['EPF_EE']), pf_er: sumCode('employer', ['EPF_ER', 'EPS']), pf_other: sumCode('employer', ['EDLI', 'PF_ADMIN']),
    esi_ee: sumCode('deductions', ['ESI_EE']), esi_er: sumCode('employer', ['ESI_ER']), pt: sumCode('deductions', ['PT']), tds: sumCode('deductions', ['TDS']),
    employer_cost: r2(slips.reduce((a, s) => a + s.employer_cost, 0)),
  };
}

export function approvePayRun(id: number, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const run = d.get<Row>('SELECT * FROM pay_runs WHERE id = ?', id) ?? fail('Pay run not found', 404);
    if (run.status !== 'draft') fail('Pay run is already approved', 422);
    assertUnlocked('payroll', run.pay_date, 'pay run');
    const t = payRunTotals(id);
    const lines: JLine[] = [
      { account_id: acct('salaries'), debit: t.gross, description: 'Gross salaries' },
      { account_id: acct('employer_pf'), debit: r2(t.pf_er + t.pf_other) },
      { account_id: acct('employer_esi'), debit: t.esi_er },
      { account_id: acct('epf_payable'), credit: r2(t.pf_ee + t.pf_er + t.pf_other) },
      { account_id: acct('esi_payable'), credit: r2(t.esi_ee + t.esi_er) },
      { account_id: acct('pt_payable'), credit: t.pt },
      { account_id: acct('tds_salary_payable'), credit: t.tds },
      { account_id: acct('salary_payable'), credit: t.net },
    ];
    replaceJournal('pay_run', id, { date: run.pay_date, memo: `Payroll for ${run.period}`, reference: run.number, lines });
    d.update('pay_runs', id, { status: 'approved' });
    audit('pay_run', id, 'approved', `Pay run ${run.period} approved`, user);
  });
}

export function recordPayRunPayment(id: number, input: Row, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const run = d.get<Row>('SELECT * FROM pay_runs WHERE id = ?', id) ?? fail('Pay run not found', 404);
    if (run.status !== 'approved') fail('Approve the pay run before recording payment', 422);
    const account = d.get<Row>('SELECT * FROM accounts WHERE id = ?', input.account_id) ?? fail('Choose the paying bank account', 422);
    if (!['bank', 'cash'].includes(account.type)) fail('Salaries must be paid from a bank or cash account', 422);
    const date = input.date ?? run.pay_date;
    assertUnlocked('payroll', date, 'salary payment');
    const t = payRunTotals(id);
    replaceJournal('pay_run_payment', id, {
      date, memo: `Salary payment for ${run.period}`, reference: run.number,
      lines: [{ account_id: acct('salary_payable'), debit: t.net_payable }, { account_id: account.id, credit: t.net_payable }],
    });
    d.update('pay_runs', id, { status: 'paid', paid_account_id: account.id, paid_date: date });
    audit('pay_run', id, 'paid', `Salaries of ₹${t.net_payable} paid for ${run.period}`, user);
  });
}

export function releaseWithheld(payslipId: number, input: Row, user?: AuthUser) {
  return db().tx(() => {
    const d = db();
    const ps = d.get<Row>('SELECT * FROM payslips WHERE id = ?', payslipId) ?? fail('Payslip not found', 404);
    if (!ps.withheld) fail('This salary is not withheld', 422);
    const run = d.get<Row>('SELECT * FROM pay_runs WHERE id = ?', ps.pay_run_id)!;
    if (run.status !== 'paid') fail('Record the pay run payment first', 422);
    const account = d.get<Row>('SELECT * FROM accounts WHERE id = ?', input.account_id ?? run.paid_account_id) ?? fail('Account not found', 422);
    const date = input.date ?? new Date().toISOString().slice(0, 10);
    replaceJournal('payslip_release', payslipId, { date, memo: `Release of withheld salary (${run.period})`, lines: [{ account_id: acct('salary_payable'), debit: ps.net }, { account_id: account.id, credit: ps.net }] });
    d.update('payslips', payslipId, { withheld: 0, extra: JSON.stringify({ ...json<Row>(ps.extra, {}), released_on: date }) });
    audit('pay_run', run.id, 'release', `Withheld salary released`, user);
  });
}

export function deletePayRun(id: number, user?: AuthUser) {
  const d = db();
  const run = d.get<Row>('SELECT * FROM pay_runs WHERE id = ?', id) ?? fail('Pay run not found', 404);
  if (run.status !== 'draft') fail('Only draft pay runs can be deleted', 422);
  d.run('DELETE FROM pay_runs WHERE id = ?', id);
  audit('pay_run', id, 'deleted', `Pay run ${run.period} deleted`, user);
}

export function getPayRun(id: number) {
  const d = db();
  const run = d.get<Row>('SELECT * FROM pay_runs WHERE id = ?', id) ?? fail('Pay run not found', 404);
  const payslips = d.all<Row>(
    `SELECT p.*, e.name AS employee_name, e.emp_code, e.pan, e.uan, dep.name AS department FROM payslips p JOIN employees e ON e.id = p.employee_id
     LEFT JOIN departments dep ON dep.id = e.department_id WHERE p.pay_run_id = ? ORDER BY e.emp_code`, id)
    .map((p) => ({ ...p, earnings: json(p.earnings, []), deductions: json(p.deductions, []), employer: json(p.employer, []), extra: json(p.extra, {}) }));
  return { ...run, totals: payRunTotals(id), payslips, journal: [...journalsFor('pay_run', id), ...journalsFor('pay_run_payment', id)] };
}

export function listPayRuns() {
  return db().all<Row>('SELECT * FROM pay_runs ORDER BY period DESC').map((r) => ({ ...r, totals: payRunTotals(r.id) }));
}

export function getPayslip(id: number) {
  const d = db();
  const p = d.get<Row>(
    `SELECT p.*, r.period, r.pay_date, r.status AS run_status, e.name AS employee_name, e.emp_code, e.pan, e.uan, e.esi_number, e.doj, e.bank_name, e.bank_account,
            dep.name AS department, des.name AS designation
     FROM payslips p JOIN pay_runs r ON r.id = p.pay_run_id JOIN employees e ON e.id = p.employee_id
     LEFT JOIN departments dep ON dep.id = e.department_id LEFT JOIN designations des ON des.id = e.designation_id WHERE p.id = ?`, id) ?? fail('Payslip not found', 404);
  return { ...p, earnings: json(p.earnings, []), deductions: json(p.deductions, []), employer: json(p.employer, []), extra: json(p.extra, {}), org: org() };
}

export function listEmployees(q: Row = {}) {
  return db().all<Row>(
    `SELECT e.*, dep.name AS department, des.name AS designation FROM employees e LEFT JOIN departments dep ON dep.id = e.department_id
     LEFT JOIN designations des ON des.id = e.designation_id ${q.status ? 'WHERE e.status = ?' : ''} ORDER BY e.emp_code`, ...(q.status ? [q.status] : []))
    .map((e) => ({ ...e, components: json(e.components, {}) }));
}

export function getEmployee(id: number) {
  const d = db();
  const e = d.get<Row>('SELECT e.*, dep.name AS department, des.name AS designation FROM employees e LEFT JOIN departments dep ON dep.id = e.department_id LEFT JOIN designations des ON des.id = e.designation_id WHERE e.id = ?', id) ?? fail('Employee not found', 404);
  const s = payrollSettings();
  let salary: Row | null = null;
  try { salary = structure(e, s, new Date().toISOString().slice(0, 10)); } catch (err: any) { salary = { error: err.message }; }
  const payslips = d.all<Row>('SELECT p.id, p.gross, p.net, p.lop_days, r.period, r.status FROM payslips p JOIN pay_runs r ON r.id = p.pay_run_id WHERE p.employee_id = ? ORDER BY r.period DESC', id);
  return { ...e, components: json(e.components, {}), salary, payslips };
}
