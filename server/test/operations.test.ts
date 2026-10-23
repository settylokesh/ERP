import { beforeEach, describe, expect, it } from 'vitest';
import { disposeAsset, registerAsset, runDepreciation, saveAsset, saveManualJournal, depreciationSchedule } from '../src/accountant.js';
import { categorizeLine, completeReconciliation, importStatement, matchSuggestions, matchLine, reconciliationData, saveBankTransaction, statementLines } from '../src/banking.js';
import { db } from '../src/db.js';
import { createDocument, updateDocument } from '../src/documents/engine.js';
import { acct } from '../src/ledger.js';
import { completeMo, confirmMo, createInspection, jobCardAction, materialAvailability, mrp, recordInspection, saveBom, saveMo, saveQualityRule, saveWorkCenter, getMo } from '../src/manufacturing.js';
import { saveItem } from '../src/masters.js';
import { createPayment, deletePayment } from '../src/payments.js';
import { annualTax, approvePayRun, computePayslip, createPayRun, getPayRun, recordPayRunPayment, saveEmployee, structure } from '../src/payroll.js';
import { payrollSettings } from '../src/settings.js';
import { bal, buy, fresh, inventoryReconciles, stock, trialBalanced, type Ctx } from './helpers.js';

let c: Ctx;
beforeEach(() => { c = fresh(); });

describe('Manufacturing', () => {
  function setup() {
    const steel = saveItem({ name: 'Steel', sku: 'ST', unit: 'kg', tax_id: c.tax18, purchase_rate: 50 });
    const motor = saveItem({ name: 'Motor', sku: 'MT', tax_id: c.tax18, purchase_rate: 1000 });
    const pump = saveItem({ name: 'Pump', sku: 'PM', tax_id: c.tax18, sales_rate: 5000 });
    buy(c, 100, 50, '2026-05-01', steel);
    buy(c, 10, 1000, '2026-05-01', motor);
    const wc = saveWorkCenter({ name: 'Assembly', cost_per_hour: 600 });
    const bom = saveBom({ item_id: pump, quantity: 1, overhead_cost: 100, components: [{ item_id: steel, qty: 4, wastage_pct: 0 }, { item_id: motor, qty: 1 }], operations: [{ name: 'Assemble', work_center_id: wc, minutes: 30 }] });
    return { steel, motor, pump, wc, bom };
  }

  it('produces finished goods at material + labour + overhead cost', () => {
    const { steel, motor, pump, bom } = setup();
    const mo = saveMo({ bom_id: bom, qty: 5, date: '2026-05-02', warehouse_id: c.wh });
    expect(materialAvailability(mo).every((x) => x.shortage === 0)).toBe(true);
    confirmMo(mo, c.admin);
    const jc = db().get('SELECT * FROM job_cards WHERE mo_id = ?', mo);
    expect(jc.planned_minutes).toBe(150);
    jobCardAction(jc.id, 'start', {}, c.admin);
    jobCardAction(jc.id, 'complete', { minutes: 180 }, c.admin);
    completeMo(mo, { date: '2026-05-03' }, c.admin);
    const m = getMo(mo);
    // material: 5 x (4 x 50 + 1000) = 6000; labour: 180 min x 600/h = 1800; overhead 5 x 100 = 500
    expect(m.cost).toMatchObject({ material: 6000, labour: 1800, overhead: 500, total: 8300, per_unit: 1660 });
    expect(stock(pump)).toBe(5);
    expect(stock(steel)).toBe(80);
    expect(stock(motor)).toBe(5);
    expect(bal('mfg_absorption')).toBe(-2300);
    expect(inventoryReconciles()).toBe(true);
    expect(trialBalanced()).toBe(true);
    // the finished goods now carry their production cost into COGS
    const inv = createDocument('invoice', { date: '2026-05-04', contact_id: c.cust, lines: [{ item_id: pump, qty: 1, rate: 5000 }] }, c.admin, { submit: true });
    expect(-db().value("SELECT SUM(value) FROM stock_moves WHERE source_type = 'invoice' AND source_id = ?", inv)).toBe(1660);
  });

  it('requires a quality inspection when the item has QC rules and books only accepted output', () => {
    const { pump, bom } = setup();
    saveQualityRule({ item_id: pump, applies_to: 'manufacturing', parameters: [{ name: 'Pressure', type: 'numeric', min: 2, max: 3 }] });
    const mo = saveMo({ bom_id: bom, qty: 4, date: '2026-05-02', warehouse_id: c.wh });
    confirmMo(mo, c.admin);
    expect(() => completeMo(mo, { auto_complete_job_cards: true }, c.admin)).toThrow(/quality inspection/);
    const qi = createInspection({ source_type: 'mo', source_id: mo, qty: 4 }, c.admin);
    expect(() => recordInspection(qi, { accepted_qty: 3, rejected_qty: 2 }, c.admin)).toThrow(/must equal/);
    recordInspection(qi, { accepted_qty: 3, rejected_qty: 1, results: [{ parameter: 'Pressure', value: 2.5 }] }, c.admin);
    completeMo(mo, { auto_complete_job_cards: true, date: '2026-05-03' }, c.admin);
    expect(stock(pump)).toBe(3);
    expect(getMo(mo)).toMatchObject({ produced_qty: 3, rejected_qty: 1, status: 'completed' });
  });

  it('re-costs finished goods when a component purchase is back-dated', () => {
    const { pump, bom, steel } = setup();
    const mo = saveMo({ bom_id: bom, qty: 1, date: '2026-05-10', warehouse_id: c.wh });
    confirmMo(mo, c.admin);
    completeMo(mo, { auto_complete_job_cards: true, date: '2026-05-10' }, c.admin);
    const before = db().value("SELECT value FROM stock_moves WHERE source_type = 'mo' AND kind = 'mo_produce'");
    buy(c, 50, 10, '2026-04-20', steel); // cheaper steel bought earlier
    const after = db().value("SELECT value FROM stock_moves WHERE source_type = 'mo' AND kind = 'mo_produce'");
    expect(after).toBe(before - 4 * 40);
    expect(inventoryReconciles()).toBe(true);
    void pump;
  });

  it('suggests make/buy actions in MRP', () => {
    const { pump, motor } = setup();
    createDocument('sales_order', { date: '2026-05-02', contact_id: c.cust, lines: [{ item_id: pump, qty: 20, rate: 5000 }] }, c.admin, { submit: true });
    const rows = mrp();
    expect(rows.find((r) => r.item_id === pump)).toMatchObject({ so_demand: 20, action: 'make', shortage: 20 });
    void motor;
  });

  it('rejects circular BOMs', () => {
    const { pump, steel, bom } = setup();
    void bom;
    expect(() => saveBom({ item_id: steel, components: [{ item_id: pump, qty: 1 }] })).toThrow(/circular/);
  });
});

describe('Payroll', () => {
  it('splits CTC into salary components including employer PF', () => {
    const e = saveEmployee({ emp_code: 'E1', name: 'A', doj: '2024-01-01', annual_ctc: 600000, work_state: '29' });
    const s = structure(db().get('SELECT * FROM employees WHERE id = ?', e), payrollSettings(), '2026-10-01');
    expect(s.monthlyCtc).toBe(50000);
    const basic = s.earnings.find((x) => x.code === 'BASIC')!.amount;
    expect(basic).toBe(25000);
    expect(s.earnings.find((x) => x.code === 'HRA')!.amount).toBe(12500);
    // employer PF 12% of min(basic, Rs 25,000 ceiling from 17-Sep-2026) = 3000
    expect(s.gross).toBe(47000);
    expect(s.esiApplies).toBe(false);
  });

  it('computes statutory deductions on a payslip', () => {
    const e = saveEmployee({ emp_code: 'E2', name: 'B', doj: '2024-01-01', annual_ctc: 252000, work_state: '29' });
    const emp = db().get('SELECT * FROM employees WHERE id = ?', e);
    const p = computePayslip(emp, '2026-10', 0, payrollSettings());
    const ded = Object.fromEntries(p.deductions.map((x) => [x.code, x.amount]));
    const er = Object.fromEntries(p.employer.map((x) => [x.code, x.amount]));
    expect(ded.EPF_EE).toBe(1260); // 12% of basic 10,500
    expect(er.EPF_ER + er.EPS).toBe(1260);
    expect(er.EPS).toBe(Math.round(10500 * 0.0833)); // EPS on wages up to Rs 15,000
    expect(ded.ESI_EE).toBe(Math.ceil(p.gross * 0.0075));
    expect(er.ESI_ER).toBe(Math.ceil(p.gross * 0.0325));
    expect(ded.PT).toBeUndefined(); // below Karnataka's Rs 25,000 threshold
    expect(ded.TDS).toBeUndefined();
    expect(p.net).toBe(Math.round((p.gross - p.total_deductions) * 100) / 100);
  });

  it('applies loss of pay and Karnataka professional tax', () => {
    const e = saveEmployee({ emp_code: 'E3', name: 'C', doj: '2024-01-01', annual_ctc: 600000, work_state: '29' });
    const emp = db().get('SELECT * FROM employees WHERE id = ?', e);
    const full = computePayslip(emp, '2026-10', 0, payrollSettings());
    const lop = computePayslip(emp, '2026-10', 3.1, payrollSettings());
    expect(lop.paid_days).toBe(27.9);
    expect(lop.gross).toBeLessThan(full.gross);
    expect(full.deductions.find((x) => x.code === 'PT')!.amount).toBe(200);
    expect(computePayslip(emp, '2027-02', 0, payrollSettings()).deductions.find((x) => x.code === 'PT')!.amount).toBe(300);
  });

  it('computes new-regime income tax with rebate, marginal relief and cess', () => {
    const s = payrollSettings();
    expect(annualTax(1200000, s)).toBe(0); // full rebate up to Rs 12 lakh
    expect(annualTax(1250000, s)).toBe(52000); // marginal relief: 50,000 + 4% cess
    expect(annualTax(1600000, s)).toBe(Math.round(120000 * 1.04));
    expect(annualTax(2500000, s)).toBe(Math.round((20000 + 40000 + 60000 + 80000 + 100000 + 30000) * 1.04));
  });

  it('runs payroll end to end with balanced journals', () => {
    saveEmployee({ emp_code: 'E4', name: 'D', doj: '2024-01-01', annual_ctc: 1800000, work_state: '29' });
    saveEmployee({ emp_code: 'E5', name: 'E', doj: '2026-10-15', annual_ctc: 300000, work_state: '29' });
    const run = createPayRun({ period: '2026-10' }, c.admin);
    const pr = getPayRun(run);
    expect(pr.payslips).toHaveLength(2);
    const joiner = pr.payslips.find((p: any) => p.emp_code === 'E5');
    expect(joiner.paid_days).toBe(17); // joined on the 15th
    expect(pr.payslips.find((p: any) => p.emp_code === 'E4').extra.tds).toBeGreaterThan(0);
    approvePayRun(run, c.admin);
    expect(bal('salaries')).toBe(pr.totals.gross);
    expect(bal('salary_payable')).toBe(pr.totals.net);
    recordPayRunPayment(run, { account_id: c.bank, date: '2026-10-31' }, c.admin);
    expect(bal('salary_payable')).toBe(0);
    expect(trialBalanced()).toBe(true);
    expect(() => createPayRun({ period: '2026-10' }, c.admin)).toThrow(/already exists/);
  });
});

describe('Banking', () => {
  it('imports statements, matches payments, categorises and reconciles', () => {
    const inv = createDocument('invoice', { date: '2026-05-01', contact_id: c.cust, lines: [{ item_id: c.service, qty: 1, rate: 1000, tax_id: c.tax18 }] }, c.admin, { submit: true });
    createPayment({ kind: 'received', date: '2026-05-10', contact_id: c.cust, amount: 1180, account_id: c.bank, allocations: [{ document_id: inv, amount: 1180 }] }, c.admin);
    const res = importStatement(c.bank, 'Date,Description,Reference,Withdrawal,Deposit\n10/05/2026,NEFT KA CUSTOMER,N1,,1180\n12/05/2026,Bank charges,C1,50,\n12/05/2026,Bank charges,C1,50,', c.admin);
    expect(res).toMatchObject({ imported: 2, skipped: 1 }); // duplicate line skipped
    const [charges, deposit] = statementLines(c.bank);
    const sugg = matchSuggestions(deposit.id);
    expect(sugg[0]).toMatchObject({ source_type: 'payment' });
    matchLine(deposit.id, 'payment', sugg[0].source_id, c.admin);
    categorizeLine(charges.id, { kind: 'expense', offset_account_id: acct('bank_charges') }, c.admin);
    expect(bal('bank_charges')).toBe(50);
    const data = reconciliationData(c.bank, '2026-05-31');
    expect(() => completeReconciliation({ account_id: c.bank, end_date: '2026-05-31', closing_balance: 1000, cleared_line_ids: data.lines.map((l) => l.id) }, c.admin)).toThrow(/does not match/);
    completeReconciliation({ account_id: c.bank, end_date: '2026-05-31', closing_balance: 1130, cleared_line_ids: data.lines.map((l) => l.id) }, c.admin);
    expect(reconciliationData(c.bank, '2026-06-30').lines).toHaveLength(0);
  });

  it('blocks editing reconciled expenses and frees statement matches when a payment is deleted', () => {
    const exp = createDocument('expense', { date: '2026-05-01', data: { paid_through_account_id: c.bank }, lines: [{ account_id: acct('rent'), qty: 1, rate: 1000 }] }, c.admin, { submit: true });
    const lines = reconciliationData(c.bank, '2026-05-31').lines;
    completeReconciliation({ account_id: c.bank, end_date: '2026-05-31', closing_balance: -1000, cleared_line_ids: lines.map((l) => l.id) }, c.admin);
    expect(() => updateDocument(exp, { date: '2026-05-01', data: { paid_through_account_id: c.bank }, lines: [{ account_id: acct('rent'), qty: 1, rate: 2000 }] }, c.admin)).toThrow(/reconciliation/);
    const inv = createDocument('invoice', { date: '2026-06-01', contact_id: c.cust, lines: [{ item_id: c.service, qty: 1, rate: 100 }] }, c.admin, { submit: true });
    const p = createPayment({ kind: 'received', date: '2026-06-02', contact_id: c.cust, amount: 118, account_id: c.bank, allocations: [{ document_id: inv, amount: 118 }] }, c.admin);
    importStatement(c.bank, 'Date,Description,Amount\n2026-06-02,Receipt,118', c.admin);
    const line = statementLines(c.bank)[0];
    matchLine(line.id, 'payment', p, c.admin);
    deletePayment(p, c.admin);
    expect(statementLines(c.bank)[0].status).toBe('uncategorized');
  });

  it('records transfers and owner contributions', () => {
    saveBankTransaction({ kind: 'owner_contribution', date: '2026-05-01', account_id: c.bank, offset_account_id: acct('share_capital'), amount: 100000 }, c.admin);
    saveBankTransaction({ kind: 'transfer_out', date: '2026-05-02', account_id: c.bank, offset_account_id: acct('petty_cash'), amount: 5000 }, c.admin);
    expect(bal('petty_cash')).toBe(5000);
    expect(bal('share_capital')).toBe(100000);
    expect(() => saveBankTransaction({ kind: 'transfer_out', account_id: c.bank, offset_account_id: acct('rent'), amount: 1 }, c.admin)).toThrow(/cannot be used/);
  });
});

describe('Fixed assets and journals', () => {
  it('depreciates straight-line and disposes with gain/loss', () => {
    const type = db().value<number>("SELECT id FROM asset_types WHERE name = 'Computers'");
    const a = saveAsset({ name: 'Laptop', asset_type_id: type, purchase_date: '2026-04-01', cost: 72000, salvage_value: 0, useful_life_months: 36, acquisition_account_id: c.bank }, c.admin);
    registerAsset(a, c.admin);
    expect(bal('computers')).toBe(72000);
    expect(depreciationSchedule(db().get('SELECT * FROM assets WHERE id = ?', a))).toHaveLength(36);
    runDepreciation('2026-09-30', c.admin);
    expect(bal('depreciation')).toBe(12000); // 6 months x 2000
    expect(runDepreciation('2026-09-30', c.admin)).toBe(0); // idempotent
    const r = disposeAsset(a, { date: '2026-10-01', amount: 50000, account_id: c.bank }, c.admin);
    expect(r.gain).toBe(-10000); // book value 60,000 sold for 50,000
    expect(bal('computers')).toBe(0);
    expect(trialBalanced()).toBe(true);
  });

  it('validates manual journals', () => {
    expect(() => saveManualJournal({ date: '2026-05-01', lines: [{ account_id: acct('rent'), debit: 100 }, { account_id: c.bank, credit: 90 }] }, c.admin)).toThrow(/not balanced/);
    expect(() => saveManualJournal({ date: '2026-05-01', lines: [{ account_id: acct('accounts_receivable'), debit: 100 }, { account_id: c.bank, credit: 100 }] }, c.admin)).toThrow(/choose a contact/);
    expect(() => saveManualJournal({ date: '2026-05-01', lines: [{ account_id: acct('inventory_asset'), debit: 100 }, { account_id: c.bank, credit: 100 }] }, c.admin)).toThrow(/inventory/);
    saveManualJournal({ date: '2026-05-01', lines: [{ account_id: acct('rent'), debit: 100 }, { account_id: c.bank, credit: 100 }] }, c.admin);
    expect(bal('rent')).toBe(100);
  });
});
