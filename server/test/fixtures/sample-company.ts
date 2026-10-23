import { saveAsset, registerAsset, runDepreciation, saveBudget, saveManualJournal } from '../../src/accountant.js';
import { hashPassword, loadUser } from '../../src/auth.js';
import { saveBankTransaction, importStatement } from '../../src/banking.js';
import { saveWorkflow } from '../../src/custom.js';
import { db, type Row } from '../../src/db.js';
import { runAction } from '../../src/documents/actions.js';
import { createDocument, createFrom } from '../../src/documents/engine.js';
import { acct } from '../../src/ledger.js';
import { completeMo, confirmMo, jobCardAction, recordInspection, createInspection, saveBom, saveMo, saveQualityRule, saveWorkCenter } from '../../src/manufacturing.js';
import { saveAccount, saveContact, saveItem, saveWarehouse } from '../../src/masters.js';
import { createPayment } from '../../src/payments.js';
import { approvePayRun, createPayRun, recordPayRunPayment, saveEmployee, updatePayslip } from '../../src/payroll.js';
import { getKv, setKv, DEFAULT_ORG } from '../../src/settings.js';
import { addDays, makeGstin, today } from '../../src/util.js';

/** Password of the sample company's non-admin users (test environments only). */
export const SAMPLE_USER_PASSWORD = 'sample-pass-123';

/**
 * TEST FIXTURE - never loaded by the application.
 *
 * Builds a realistic sample company (a pump manufacturer in Bengaluru) for end-to-end tests by running real business
 * flows through the same services the API uses, so every journal, stock move and status is produced by the engine.
 * Requires an initialised database with a first administrator.
 */
export function loadSampleCompany() {
  const d = db();
  if (d.get('SELECT 1 FROM contacts')) return false;
  const admin = loadUser(d.value<number>('SELECT id FROM users ORDER BY id LIMIT 1'))!;
  d.tx(() => {
    setKv('org', { ...DEFAULT_ORG, ...getKv('org', DEFAULT_ORG), ...SAMPLE_ORG });
    const wh1 = d.value<number>('SELECT id FROM warehouses WHERE is_primary = 1');
    d.update('warehouses', wh1, { name: 'Peenya Main Warehouse', code: 'BLR-01', address: 'Plot 42, Peenya Industrial Area', city: 'Bengaluru', pincode: '560058', state_code: '29' });
    const wh2 = saveWarehouse({ name: 'Hosur Road Finished Goods', code: 'BLR-02', state_code: '29', address: 'Bommasandra, Bengaluru' });
    const hdfc = saveAccount({ code: '1020', name: 'HDFC Bank Current A/c', type: 'bank', bank_name: 'HDFC Bank', account_number: '50200012345678', ifsc: 'HDFC0000523' });
    const icici = saveAccount({ code: '1021', name: 'ICICI Bank OD A/c', type: 'bank', bank_name: 'ICICI Bank', account_number: '000405012345', ifsc: 'ICIC0000004' });
    const card = saveAccount({ code: '2600', name: 'Corporate Credit Card', type: 'credit_card' });

    for (const [email, name, role] of [['sales@example.com', 'Priya Sharma', 'Sales Executive'], ['accounts@example.com', 'Arjun Rao', 'Accountant'], ['stores@example.com', 'Imran Khan', 'Warehouse Manager'], ['production@example.com', 'Lakshmi Narayan', 'Production Manager'], ['hr@example.com', 'Neha Gupta', 'HR Manager'], ['purchase@example.com', 'Vikram Singh', 'Purchase Officer']]) {
      d.insert('users', { name, email, password_hash: hashPassword(SAMPLE_USER_PASSWORD), role_id: d.value('SELECT id FROM roles WHERE name = ?', role) });
    }
    for (const n of ['Production', 'Sales', 'Accounts', 'Stores']) d.insert('departments', { name: n });
    for (const n of ['Machine Operator', 'Production Supervisor', 'Sales Executive', 'Accountant', 'Store Keeper']) d.insert('designations', { name: n });
    d.insert('currencies', { code: 'USD', name: 'US Dollar', symbol: '$', rate: 88, is_base: 0 });

    const rows = sampleRows();
    const cust = rows.customers.map((c: Row) => saveContact({ kind: 'customer', ...c }, admin));
    const vend = rows.vendors.map((v: Row) => saveContact({ kind: 'vendor', ...v }, admin));
    const tax = (rate: number) => d.value<number>('SELECT id FROM taxes WHERE rate = ? AND is_active = 1', rate);

    const ob = (qty: number, rate: number, wh = wh1, tracking?: Row[]) => [{ warehouse_id: wh, qty, rate, tracking }];
    const steel = saveItem({ name: 'MS Steel Sheet 2mm', sku: 'RM-STL-02', unit: 'kg', hsn_code: '7208', tax_id: tax(18), purchase_rate: 68, sales_rate: 85, reorder_level: 200, preferred_vendor_id: vend[0], opening_stock: ob(600, 66) }, admin);
    const copper = saveItem({ name: 'Copper Winding Wire 18 SWG', sku: 'RM-CU-18', unit: 'kg', hsn_code: '7408', tax_id: tax(18), purchase_rate: 820, sales_rate: 950, reorder_level: 40, preferred_vendor_id: vend[1], opening_stock: ob(90, 800) }, admin);
    const bearing = saveItem({ name: 'Ball Bearing 6203-2RS', sku: 'RM-BRG-6203', unit: 'pcs', hsn_code: '8482', tax_id: tax(18), purchase_rate: 48, sales_rate: 75, reorder_level: 100, preferred_vendor_id: vend[4], opening_stock: ob(300, 46) }, admin);
    const motor = saveItem({ name: 'Induction Motor 1HP', sku: 'RM-MTR-1HP', unit: 'pcs', hsn_code: '8501', tax_id: tax(18), purchase_rate: 2850, sales_rate: 3600, reorder_level: 10, preferred_vendor_id: vend[1], opening_stock: ob(25, 2800) }, admin);
    const impeller = saveItem({
      name: 'Brass Impeller 100mm', sku: 'RM-IMP-100', unit: 'pcs', hsn_code: '8413', tax_id: tax(18), purchase_rate: 340, sales_rate: 480, reorder_level: 20, tracking: 'batch',
      opening_stock: ob(40, 330, wh1, [{ batch_no: 'IMP-2604', qty: 40, expiry_date: null }]),
    }, admin);
    const box = saveItem({ name: 'Corrugated Packing Box (Pump)', sku: 'PK-BOX-01', unit: 'pcs', hsn_code: '4819', tax_id: tax(5), purchase_rate: 28, sales_rate: 40, reorder_level: 50, opening_stock: ob(150, 27) }, admin);
    const pump = saveItem({ name: 'Kaveri Monoblock Pump 1HP', sku: 'FG-PMP-1HP', unit: 'pcs', hsn_code: '8413', tax_id: tax(18), purchase_rate: 0, sales_rate: 7800, reorder_level: 5, description: '1HP single-phase monoblock water pump, 25m head', opening_stock: ob(6, 5200, wh2) }, admin);
    const controller = saveItem({ name: 'Pump Controller with Dry-Run Protection', sku: 'FG-CTL-01', unit: 'pcs', hsn_code: '8537', tax_id: tax(18), purchase_rate: 1450, sales_rate: 2400, reorder_level: 5, tracking: 'serial', opening_stock: ob(4, 1400, wh1, [{ serial_no: 'CTL-0001' }, { serial_no: 'CTL-0002' }, { serial_no: 'CTL-0003' }, { serial_no: 'CTL-0004' }]) }, admin);
    const install = saveItem({ name: 'Installation & Commissioning', sku: 'SV-INST', type: 'service', unit: 'job', hsn_code: '998719', tax_id: tax(18), sales_rate: 1200 }, admin);
    const amc = saveItem({ name: 'Annual Maintenance Contract', sku: 'SV-AMC', type: 'service', unit: 'year', hsn_code: '998719', tax_id: tax(18), sales_rate: 3500 }, admin);
    void amc;

    const wcCut = saveWorkCenter({ code: 'WC-CUT', name: 'Sheet Cutting & Pressing', cost_per_hour: 420, capacity_hours: 8 });
    const wcWind = saveWorkCenter({ code: 'WC-WND', name: 'Motor Fitment', cost_per_hour: 480, capacity_hours: 8 });
    const wcAsm = saveWorkCenter({ code: 'WC-ASM', name: 'Pump Assembly Line', cost_per_hour: 380, capacity_hours: 16 });
    const wcTest = saveWorkCenter({ code: 'WC-TST', name: 'Hydro Testing Bay', cost_per_hour: 300, capacity_hours: 8 });
    const bom = saveBom({
      item_id: pump, name: 'Monoblock Pump 1HP - Standard', quantity: 1, overhead_cost: 180,
      components: [{ item_id: steel, qty: 4.5, wastage_pct: 4 }, { item_id: bearing, qty: 2 }, { item_id: motor, qty: 1 }, { item_id: impeller, qty: 1 }, { item_id: box, qty: 1 }],
      operations: [{ name: 'Cut and press casing', work_center_id: wcCut, minutes: 20 }, { name: 'Fit motor and impeller', work_center_id: wcWind, minutes: 30 }, { name: 'Final assembly', work_center_id: wcAsm, minutes: 25 }, { name: 'Hydrostatic test', work_center_id: wcTest, minutes: 15 }],
    }, admin);
    saveQualityRule({ item_id: pump, name: 'Pump final inspection', applies_to: 'manufacturing', parameters: [{ name: 'Discharge pressure (bar)', type: 'numeric', min: 2.2, max: 3.0 }, { name: 'Leak test', type: 'pass_fail' }, { name: 'Noise level (dB)', type: 'numeric', min: 0, max: 75 }] });

    const t = today();
    const day = (n: number) => addDays(t, -n);
    const act = (docId: number, action: string, body: Row = {}) => runAction(docId, action, body, admin);

    // Procure-to-pay: PR -> PO -> receive -> bill -> payment
    const pr = createDocument('purchase_request', { date: day(40), reference: 'Production plan - Q3', notes: 'Raw material for pump batch', lines: [{ item_id: steel, qty: 500 }, { item_id: bearing, qty: 200 }] }, admin, { submit: true });
    const po1 = createFrom(pr, 'purchase_order', admin, { contact_id: vend[0], date: day(39), lines: [{ item_id: steel, qty: 500, rate: 67, ref_line_id: d.value('SELECT id FROM document_lines WHERE document_id = ? AND item_id = ?', pr, steel) }] }, true);
    const grn1 = createFrom(po1, 'purchase_receive', admin, { date: day(35) });
    void grn1;
    const bill1 = createFrom(po1, 'bill', admin, { date: day(35), reference: 'DSS/2026/1187', data: { vendor_invoice_no: 'DSS/2026/1187' } });
    createPayment({ kind: 'made', date: day(20), contact_id: vend[0], amount: d.value<number>('SELECT total FROM documents WHERE id = ?', bill1), account_id: hdfc, mode: 'neft', reference: 'NEFT-HDFC-88121', allocations: [{ document_id: bill1, amount: d.value<number>('SELECT total FROM documents WHERE id = ?', bill1) }] }, admin);

    // Inter-state purchase (IGST) with freight landed cost and a reverse-charge GTA bill
    const bill2 = createDocument('bill', {
      date: day(28), contact_id: vend[1], reference: 'GE/INV/4471', warehouse_id: wh1, data: { vendor_invoice_no: 'GE/INV/4471' },
      lines: [{ item_id: motor, qty: 20, rate: 2900 }, { item_id: copper, qty: 50, rate: 830 }, { account_id: acct('freight_inward'), description: 'Freight charges', qty: 1, rate: 4500, tax_id: tax(18), data: { landed_cost: true } }],
    }, admin, { submit: true });
    createPayment({ kind: 'made', date: day(10), contact_id: vend[1], amount: 50000, account_id: hdfc, mode: 'rtgs', reference: 'RTGS-HDFC-55102', allocations: [{ document_id: bill2, amount: 50000 }] }, admin);
    createDocument('bill', { date: day(27), contact_id: vend[2], reverse_charge: true, reference: 'SRC/LR/9921', lines: [{ account_id: acct('freight_inward'), description: 'GTA freight - Pune consignment', qty: 1, rate: 6000, tax_id: tax(5) }] }, admin, { submit: true });
    const tds194i = d.value<number>("SELECT id FROM tds_sections WHERE section = '194I' AND rate = 10");
    createDocument('bill', { date: day(22), contact_id: vend[3], reference: 'RENT-SEP', data: { tds_section_id: tds194i, vendor_invoice_no: 'PE/R/0926' }, lines: [{ account_id: acct('rent'), description: 'Factory rent - September', qty: 1, rate: 85000, tax_id: tax(18) }] }, admin, { submit: true });

    // Order-to-cash: quote -> SO -> package -> ship -> invoice -> payment
    const qt = createDocument('quote', { date: day(30), contact_id: cust[0], salesperson: 'Priya Sharma', lines: [{ item_id: pump, qty: 4, rate: 7800, discount_pct: 5 }, { item_id: install, qty: 4, rate: 1200 }] }, admin, { submit: true });
    act(qt, 'mark_accepted');
    const so1 = createFrom(qt, 'sales_order', admin, { date: day(29), warehouse_id: wh2 });
    const pkg = createFrom(so1, 'package', admin, { date: day(26), warehouse_id: wh2 });
    act(pkg, 'ship', { date: day(25), carrier: 'Swift Road Carriers', tracking_no: 'SRC-778812' });
    act(pkg, 'deliver', { date: day(24) });
    const inv1 = createFrom(so1, 'invoice', admin, { date: day(25) });
    createPayment({ kind: 'received', date: day(12), contact_id: cust[0], amount: 20000, account_id: hdfc, mode: 'upi', reference: 'UPI-41122', allocations: [{ document_id: inv1, amount: 20000 }] }, admin);

    // Inter-state invoice with e-invoice + e-way bill
    const inv2 = createDocument('invoice', { date: day(18), contact_id: cust[1], warehouse_id: wh1, salesperson: 'Priya Sharma', lines: [{ item_id: controller, qty: 2, rate: 2400, tracking: [{ serial_no: 'CTL-0001' }, { serial_no: 'CTL-0002' }] }, { item_id: copper, qty: 10, rate: 960 }, { item_id: bearing, qty: 50, rate: 75 }] }, admin, { submit: true });
    act(inv2, 'eway_record', { ewb_no: '381000123456', ewb_date: `${day(18)}T10:30:00`, distance: 840, transport_mode: 'road', vehicle_no: 'KA05AB4321', transporter_name: 'Swift Road Carriers' });
    const inv2Total = d.value<number>('SELECT total FROM documents WHERE id = ?', inv2);
    createPayment({ kind: 'received', date: day(5), contact_id: cust[1], amount: inv2Total, account_id: icici, mode: 'neft', reference: 'NEFT-MEW-3301', allocations: [{ document_id: inv2, amount: inv2Total }] }, admin);

    // Overdue invoice and a retail cash sale
    createDocument('invoice', { date: day(70), due_date: day(40), contact_id: cust[2], warehouse_id: wh1, lines: [{ item_id: steel, qty: 80, rate: 88 }] }, admin, { submit: true });
    const inv4 = createDocument('invoice', { date: day(8), contact_id: cust[3], warehouse_id: wh2, lines: [{ item_id: pump, qty: 1, rate: 7800 }, { item_id: install, qty: 1, rate: 1200 }] }, admin, { submit: true });
    createPayment({ kind: 'received', date: day(8), contact_id: cust[3], amount: d.value<number>('SELECT total FROM documents WHERE id = ?', inv4), account_id: acct('petty_cash'), mode: 'cash', allocations: [{ document_id: inv4, amount: d.value<number>('SELECT total FROM documents WHERE id = ?', inv4) }] }, admin);

    // Export under LUT (zero rated) in USD
    createDocument('invoice', { date: day(15), contact_id: cust[4], warehouse_id: wh1, exchange_rate: 88.2, lines: [{ item_id: motor, qty: 5, rate: 48 }] }, admin, { submit: true });

    // Credit note for a returned bearing lot
    const cnInv = d.value<number>('SELECT id FROM documents WHERE type = ? AND contact_id = ?', 'invoice', cust[1]);
    const cnLine = d.get<Row>('SELECT * FROM document_lines WHERE document_id = ? AND item_id = ?', cnInv, bearing)!;
    createDocument('credit_note', { date: day(4), contact_id: cust[1], ref_doc_id: cnInv, reference: 'Damaged in transit', lines: [{ item_id: bearing, qty: 5, rate: cnLine.rate, tax_id: cnLine.tax_id, ref_line_id: cnLine.id }] }, admin, { submit: true });

    // Open sales order awaiting production
    const so2 = createDocument('sales_order', { date: day(6), contact_id: cust[2], warehouse_id: wh1, salesperson: 'Priya Sharma', lines: [{ item_id: pump, qty: 10, rate: 7600 }] }, admin, { submit: true });

    // Manufacturing: MO -> release -> job cards -> inspection -> complete
    const mo = saveMo({ bom_id: bom, qty: 8, date: day(9), warehouse_id: wh1, sales_order_id: so2, planned_start: day(9) }, admin);
    confirmMo(mo, admin);
    for (const jc of d.all<Row>('SELECT id, planned_minutes FROM job_cards WHERE mo_id = ? ORDER BY seq', mo)) jobCardAction(jc.id, 'complete', { minutes: jc.planned_minutes * 1.1 }, admin);
    const qi = createInspection({ source_type: 'mo', source_id: mo, qty: 8 }, admin);
    recordInspection(qi, { accepted_qty: 7, rejected_qty: 1, results: [{ parameter: 'Discharge pressure (bar)', value: 2.6 }, { parameter: 'Leak test', pass: true }, { parameter: 'Noise level (dB)', value: 68 }], notes: 'One unit failed leak test' }, admin);
    completeMo(mo, { date: day(3), consumption: [], output_tracking: [] }, admin);
    const mo2 = saveMo({ bom_id: bom, qty: 5, date: day(1), warehouse_id: wh1, sales_order_id: so2, planned_start: t }, admin);
    confirmMo(mo2, admin);

    // Stock transfer and an adjustment
    const to = createDocument('transfer_order', { date: day(2), warehouse_id: wh1, to_warehouse_id: wh2, reference: 'Replenish FG store', lines: [{ item_id: pump, qty: 5 }] }, admin, { submit: true });
    act(to, 'mark_transferred', { date: day(1) });
    createDocument('inventory_adjustment', { date: day(2), warehouse_id: wh1, data: { mode: 'quantity', reason: 'Damaged sheets scrapped' }, lines: [{ item_id: steel, qty: -12 }] }, admin, { submit: true });

    // RFQ with surrogate bids
    const rfq = createDocument('rfq', { date: day(3), due_date: addDays(t, 7), data: { vendor_ids: [vend[4], vend[1]] }, lines: [{ item_id: bearing, qty: 400 }, { item_id: copper, qty: 60 }] }, admin, { submit: false });
    act(rfq, 'publish');
    const rl = d.all<Row>('SELECT id, item_id FROM document_lines WHERE document_id = ? ORDER BY line_no', rfq);
    act(rfq, 'record_bid', { vendor_id: vend[4], bids: [{ line_id: rl[0].id, rate: 44, lead_days: 7 }, { line_id: rl[1].id, rate: 845, lead_days: 10 }] });
    act(rfq, 'record_bid', { vendor_id: vend[1], bids: [{ line_id: rl[0].id, rate: 47, lead_days: 5 }, { line_id: rl[1].id, rate: 818, lead_days: 6 }] });

    // Expenses and banking
    createDocument('expense', { date: day(14), data: { paid_through_account_id: card }, contact_id: null, lines: [{ account_id: acct('travel'), description: 'Flight to Pune - customer visit', qty: 1, rate: 9600, tax_id: tax(5) }] }, admin, { submit: true });
    createDocument('expense', { date: day(11), data: { paid_through_account_id: hdfc }, lines: [{ account_id: acct('utilities'), description: 'BESCOM electricity - September', qty: 1, rate: 38500, tax_exempt: 'non_gst' }] }, admin, { submit: true });
    saveBankTransaction({ kind: 'owner_contribution', date: day(60), account_id: hdfc, offset_account_id: acct('share_capital'), amount: 1500000, description: 'Share capital infusion' }, admin);
    saveBankTransaction({ kind: 'transfer_out', date: day(19), account_id: hdfc, offset_account_id: icici, amount: 200000, description: 'Fund transfer to ICICI OD' }, admin);
    saveBankTransaction({ kind: 'interest_income', date: day(2), account_id: hdfc, offset_account_id: acct('interest_income'), amount: 1840, description: 'Sweep FD interest' }, admin);
    importStatement(hdfc, ['Date,Description,Reference,Withdrawal,Deposit',
      `${day(20)},NEFT DEECAN STEEL SUP,NEFT-HDFC-88121,${d.value<number>('SELECT total FROM documents WHERE id = ?', bill1)},`,
      `${day(12)},UPI SRI LAKSHMI AGRO,UPI-41122,,20000`,
      `${day(9)},ATM CASH WITHDRAWAL,ATM-5521,10000,`,
      `${day(2)},INT CREDIT SWEEP FD,INT-0926,,1840`,
      `${day(1)},BANK CHARGES GST,CHG-0926,236,`].join('\n'), admin);

    // Payroll
    const deps = Object.fromEntries(d.all<Row>('SELECT id, name FROM departments').map((r) => [r.name, r.id]));
    const des = Object.fromEntries(d.all<Row>('SELECT id, name FROM designations').map((r) => [r.name, r.id]));
    const emps: Row[] = [
      { emp_code: 'KPM001', name: 'Suresh Gowda', gender: 'male', doj: '2021-06-01', department_id: deps.Production, designation_id: des['Production Supervisor'], annual_ctc: 720000, pan: 'BXGPG4412K', uan: '100912345678' },
      { emp_code: 'KPM002', name: 'Anitha R', gender: 'female', doj: '2022-01-10', department_id: deps.Accounts, designation_id: des.Accountant, annual_ctc: 540000, pan: 'CQRPA2219L', uan: '100912345679' },
      { emp_code: 'KPM003', name: 'Manjunath K', gender: 'male', doj: '2023-03-15', department_id: deps.Production, designation_id: des['Machine Operator'], annual_ctc: 252000, uan: '100912345680', esi_number: '5300112233' },
      { emp_code: 'KPM004', name: 'Farah Siddiqui', gender: 'female', doj: '2020-11-02', department_id: deps.Sales, designation_id: des['Sales Executive'], annual_ctc: 1650000, pan: 'DTFPS8810C', uan: '100912345681' },
      { emp_code: 'KPM005', name: 'Ravi Teja', gender: 'male', doj: '2024-07-01', department_id: deps.Stores, designation_id: des['Store Keeper'], annual_ctc: 300000, uan: '100912345682', esi_number: '5300112244' },
    ];
    const empIds = emps.map((e) => saveEmployee({ ...e, work_state: '29', bank_name: 'HDFC Bank', bank_account: `5010${e.emp_code.slice(-3)}887766`, ifsc: 'HDFC0000523' }, admin));
    const prevMonth = addDays(`${t.slice(0, 7)}-01`, -1).slice(0, 7);
    const run = createPayRun({ period: prevMonth }, admin);
    const slip = d.value<number>('SELECT id FROM payslips WHERE pay_run_id = ? AND employee_id = ?', run, empIds[2]);
    updatePayslip(slip, { lop_days: 2 }, admin);
    approvePayRun(run, admin);
    recordPayRunPayment(run, { account_id: hdfc, date: addDays(`${t.slice(0, 7)}-01`, -1) }, admin);

    // Fixed assets and budget
    const assetType = d.value<number>("SELECT id FROM asset_types WHERE name = 'Plant and Machinery'");
    const cnc = saveAsset({ name: 'CNC Press Brake 80T', asset_type_id: assetType, purchase_date: '2026-04-10', depreciation_start: '2026-04-10', cost: 1850000, salvage_value: 92500, useful_life_months: 180, serial_no: 'PB80-22871', location: 'Peenya shop floor', acquisition_account_id: icici }, admin);
    registerAsset(cnc, admin);
    runDepreciation(addDays(`${t.slice(0, 7)}-01`, -1), admin);
    const fyYear = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
    saveBudget({ name: `FY ${fyYear}-${String((fyYear + 1) % 100).padStart(2, '0')} Operating Budget`, fiscal_year: fyYear, lines: [
      { account_id: acct('sales'), amounts: Array(12).fill(450000) },
      { account_id: acct('rent'), amounts: Array(12).fill(85000) },
      { account_id: acct('salaries'), amounts: Array(12).fill(300000) },
      { account_id: acct('utilities'), amounts: Array(12).fill(35000) },
      { account_id: acct('travel'), amounts: Array(12).fill(15000) },
    ] });
    saveManualJournal({ date: day(1), reference: 'PREPAID-INS', memo: 'Insurance premium prepaid portion', lines: [{ account_id: acct('prepaid_expenses'), debit: 24000 }, { account_id: hdfc, credit: 24000 }] }, admin);

    // Approval policy and a workflow rule
    const accountantRole = d.value<number>("SELECT id FROM roles WHERE name = 'Accountant'");
    setKv('approvals', { purchase_order: { mode: 'simple', levels: [] }, purchase_request: { mode: 'simple', levels: [] }, bill: { mode: 'multi', levels: [accountantRole] } });
    saveWorkflow({ name: 'Alert on large invoices', module: 'invoice', trigger: 'on_create', conditions: [{ field: 'total', op: 'gte', value: 100000 }], actions: [{ type: 'notify', to: 'admins', title: 'Large invoice ${number} created', body: 'Invoice total ₹${total} for ${contact_name}' }] });
    void wcAsm; void wcTest; void wcWind; void wcCut; void so1;
  });
  return true;
}

const SAMPLE_ORG = {
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

function sampleRows(): Row {
  return {
    customers: [
      { name: 'Sri Lakshmi Agro Traders', company_name: 'Sri Lakshmi Agro Traders', gst_treatment: 'business_gst', gstin: makeGstin('29', 'ABVPL7231K'), email: 'purchase@srilakshmi.example', phone: '9845012345', payment_terms: 30, billing_address: 'APMC Yard, Yeshwanthpur', billing_city: 'Bengaluru', billing_pincode: '560022', billing_state: '29' },
      { name: 'Mehta Engineering Works', company_name: 'Mehta Engineering Works', gst_treatment: 'business_gst', gstin: makeGstin('27', 'AAFFM5512Q'), email: 'stores@mehtaeng.example', phone: '9820098200', payment_terms: 45, billing_address: 'MIDC Bhosari', billing_city: 'Pune', billing_pincode: '411026', billing_state: '27' },
      { name: 'Coastal Irrigation LLP', company_name: 'Coastal Irrigation LLP', gst_treatment: 'business_gst', gstin: makeGstin('32', 'AALFC3091B'), email: 'ap@coastal.example', phone: '9447012340', payment_terms: 30, billing_address: 'Kakkanad', billing_city: 'Kochi', billing_pincode: '682030', billing_state: '32' },
      { name: 'Ramesh Kumar', gst_treatment: 'consumer', place_of_supply: '29', email: 'ramesh.k@example.com', phone: '9900112233', payment_terms: 0, billing_address: 'Jayanagar 4th Block', billing_city: 'Bengaluru', billing_pincode: '560011', billing_state: '29' },
      { name: 'Nile Water Solutions', company_name: 'Nile Water Solutions FZE', gst_treatment: 'overseas', currency_code: 'USD', email: 'buying@nilewater.example', payment_terms: 60, billing_address: 'Jebel Ali Free Zone', billing_city: 'Dubai', billing_country: 'AE', shipping_address: 'Chennai Port', shipping_city: 'Chennai', shipping_pincode: '600001', shipping_state: '33' },
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
