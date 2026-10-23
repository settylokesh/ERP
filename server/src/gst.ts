import { db, fail, json, type Row } from './db.js';
import { org } from './settings.js';
import { gstSetOff } from './tax.js';
import { monthEnd, r2, STATES } from './util.js';

const LIVE = "('open','partially_paid','paid','closed')";
const range = (period: string) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail('Return period must be YYYY-MM', 422);
  return { from: `${period}-01`, to: monthEnd(`${period}-01`) };
};
const fp = (period: string) => `${period.slice(5, 7)}${period.slice(0, 4)}`;
const dmy = (iso: string) => iso.split('-').reverse().join('-');

function docsWithLines(types: string[], from: string, to: string) {
  const d = db();
  const docs = d.all<Row>(
    `SELECT doc.*, c.name AS contact_name, c.gst_treatment AS c_treatment, c.gstin AS c_gstin FROM documents doc LEFT JOIN contacts c ON c.id = doc.contact_id
     WHERE doc.type IN (${types.map(() => '?').join(',')}) AND doc.status IN ${LIVE} AND doc.date BETWEEN ? AND ? ORDER BY doc.date, doc.number`, ...types, from, to);
  return docs.map((doc) => ({
    ...doc, data: json<Row>(doc.data, {}),
    lines: d.all<Row>('SELECT l.*, i.type AS item_type FROM document_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.document_id = ?', doc.id),
  }));
}

const rateWise = (lines: Row[], ex: number) => {
  const m = new Map<number, Row>();
  for (const l of lines) {
    if (l.tax_exempt && l.tax_exempt !== 'zero_rated') continue;
    const k = l.tax_rate;
    const cur = m.get(k) ?? { rt: k, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
    cur.txval = r2(cur.txval + l.taxable * ex);
    cur.iamt = r2(cur.iamt + l.igst * ex);
    cur.camt = r2(cur.camt + l.cgst * ex);
    cur.samt = r2(cur.samt + l.sgst * ex);
    m.set(k, cur);
  }
  return [...m.values()];
};

const isB2B = (t: string) => ['business_gst', 'business_composition', 'sez', 'deemed_export'].includes(t);
const invType = (doc: Row) => doc.c_treatment === 'sez' ? (doc.igst_total > 0 ? 'SEWP' : 'SEWOP') : doc.c_treatment === 'deemed_export' ? 'DE' : 'R';

export function gstr1(period: string) {
  const { from, to } = range(period);
  const o = org();
  const invoices = docsWithLines(['invoice'], from, to);
  const credits = docsWithLines(['credit_note'], from, to);
  const b2b: Row[] = [], b2cl: Row[] = [], exp: Row[] = [], cdnr: Row[] = [], cdnur: Row[] = [];
  const b2cs = new Map<string, Row>();
  const hsn = new Map<string, Row>();
  const nil = { inter_reg: { nil: 0, exempt: 0, ngsup: 0 }, intra_reg: { nil: 0, exempt: 0, ngsup: 0 }, inter_unreg: { nil: 0, exempt: 0, ngsup: 0 }, intra_unreg: { nil: 0, exempt: 0, ngsup: 0 } } as Record<string, Row>;

  const addHsn = (doc: Row, sign: 1 | -1) => {
    const kind = isB2B(doc.c_treatment) ? 'b2b' : 'b2c';
    for (const l of doc.lines) {
      const ex = doc.exchange_rate || 1;
      const key = `${kind}|${l.hsn_code ?? 'NA'}|${l.tax_rate}|${l.unit ?? 'OTH'}`;
      const cur = hsn.get(key) ?? { section: kind, hsn_sc: l.hsn_code ?? '', desc: l.description?.slice(0, 30), uqc: (l.unit ?? 'OTH').toUpperCase(), qty: 0, rt: l.tax_rate, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      cur.qty = r2(cur.qty + sign * l.qty);
      cur.txval = r2(cur.txval + sign * l.taxable * ex);
      cur.iamt = r2(cur.iamt + sign * l.igst * ex);
      cur.camt = r2(cur.camt + sign * l.cgst * ex);
      cur.samt = r2(cur.samt + sign * l.sgst * ex);
      hsn.set(key, cur);
    }
  };
  const addNil = (doc: Row, sign: 1 | -1) => {
    const inter = doc.place_of_supply !== o.state_code;
    const key = `${inter ? 'inter' : 'intra'}_${isB2B(doc.c_treatment) ? 'reg' : 'unreg'}`;
    for (const l of doc.lines) {
      if (!l.tax_exempt || l.tax_exempt === 'zero_rated') continue;
      const col = l.tax_exempt === 'nil' ? 'nil' : l.tax_exempt === 'exempt' ? 'exempt' : 'ngsup';
      nil[key][col] = r2(nil[key][col] + sign * l.taxable * (doc.exchange_rate || 1));
    }
  };
  const addB2cs = (doc: Row, sign: 1 | -1) => {
    for (const r of rateWise(doc.lines, doc.exchange_rate || 1)) {
      const key = `${doc.place_of_supply}|${r.rt}`;
      const cur = b2cs.get(key) ?? { sply_ty: doc.place_of_supply === o.state_code ? 'INTRA' : 'INTER', pos: doc.place_of_supply, typ: 'OE', rt: r.rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      for (const k of ['txval', 'iamt', 'camt', 'samt'] as const) cur[k] = r2(cur[k] + sign * r[k]);
      b2cs.set(key, cur);
    }
  };

  for (const doc of invoices) {
    const ex = doc.exchange_rate || 1;
    const val = r2(doc.total * ex);
    const itms = rateWise(doc.lines, ex);
    addHsn(doc, 1);
    addNil(doc, 1);
    if (doc.c_treatment === 'overseas') {
      exp.push({ exp_typ: doc.igst_total > 0 ? 'WPAY' : 'WOPAY', inum: doc.number, idt: dmy(doc.date), val, sbpnum: doc.data.shipping_bill_no ?? '', sbpdt: doc.data.shipping_bill_date ? dmy(doc.data.shipping_bill_date) : '', itms });
    } else if (isB2B(doc.c_treatment) && doc.c_gstin) {
      b2b.push({ ctin: doc.c_gstin, receiver: doc.contact_name, inum: doc.number, idt: dmy(doc.date), val, pos: doc.place_of_supply, rchrg: 'N', inv_typ: invType(doc), irn: doc.data.einvoice?.status === 'generated' ? doc.data.einvoice.irn : null, itms });
    } else if (doc.place_of_supply !== o.state_code && val > o.b2cl_threshold) {
      b2cl.push({ pos: doc.place_of_supply, inum: doc.number, idt: dmy(doc.date), val, itms });
    } else addB2cs(doc, 1);
  }
  for (const doc of credits) {
    const ex = doc.exchange_rate || 1;
    const val = r2(doc.total * ex);
    const itms = rateWise(doc.lines, ex);
    addHsn(doc, -1);
    addNil(doc, -1);
    const orig = doc.ref_doc_id ? db().get<Row>('SELECT number, date, total FROM documents WHERE id = ?', doc.ref_doc_id) : null;
    if (isB2B(doc.c_treatment) && doc.c_gstin) {
      cdnr.push({ ctin: doc.c_gstin, receiver: doc.contact_name, nt_num: doc.number, nt_dt: dmy(doc.date), ntty: 'C', val, pos: doc.place_of_supply, rchrg: 'N', inv_typ: invType(doc), orig_inum: orig?.number ?? null, itms });
    } else if (doc.c_treatment === 'overseas' || (doc.place_of_supply !== o.state_code && (orig?.total ?? val) > o.b2cl_threshold)) {
      cdnur.push({ typ: doc.c_treatment === 'overseas' ? (doc.igst_total > 0 ? 'EXPWP' : 'EXPWOP') : 'B2CL', nt_num: doc.number, nt_dt: dmy(doc.date), ntty: 'C', val, pos: doc.place_of_supply, itms });
    } else addB2cs(doc, -1);
  }
  const allInv = db().all<Row>(`SELECT number, status FROM documents WHERE type = 'invoice' AND date BETWEEN ? AND ? AND status <> 'draft' ORDER BY number`, from, to);
  const allCn = db().all<Row>(`SELECT number, status FROM documents WHERE type = 'credit_note' AND date BETWEEN ? AND ? AND status <> 'draft' ORDER BY number`, from, to);
  const docSeries = (rows: Row[], label: string, num: number) => rows.length ? [{ doc_num: num, doc_typ: label, from: rows[0].number, to: rows[rows.length - 1].number, totnum: rows.length, cancel: rows.filter((r) => r.status === 'void').length, net_issue: rows.filter((r) => r.status !== 'void').length }] : [];
  const sum = (rows: Row[], k: string) => r2(rows.reduce((a, r) => a + (r.itms ? r.itms.reduce((b: number, i: Row) => b + i[k], 0) : r[k] ?? 0), 0));
  const b2csRows = [...b2cs.values()];
  const hsnRows = [...hsn.values()];
  const summary = [
    { section: 'B2B Invoices - 4A, 4B, 6B, 6C', count: b2b.length, txval: sum(b2b, 'txval'), iamt: sum(b2b, 'iamt'), camt: sum(b2b, 'camt'), samt: sum(b2b, 'samt') },
    { section: 'B2C (Large) Invoices - 5', count: b2cl.length, txval: sum(b2cl, 'txval'), iamt: sum(b2cl, 'iamt'), camt: 0, samt: 0 },
    { section: 'B2C (Others) - 7', count: b2csRows.length, txval: sum(b2csRows, 'txval'), iamt: sum(b2csRows, 'iamt'), camt: sum(b2csRows, 'camt'), samt: sum(b2csRows, 'samt') },
    { section: 'Exports - 6A', count: exp.length, txval: sum(exp, 'txval'), iamt: sum(exp, 'iamt'), camt: 0, samt: 0 },
    { section: 'Credit/Debit Notes (Registered) - 9B', count: cdnr.length, txval: sum(cdnr, 'txval'), iamt: sum(cdnr, 'iamt'), camt: sum(cdnr, 'camt'), samt: sum(cdnr, 'samt') },
    { section: 'Credit/Debit Notes (Unregistered) - 9B', count: cdnur.length, txval: sum(cdnur, 'txval'), iamt: sum(cdnur, 'iamt'), camt: 0, samt: 0 },
  ];
  const gstn = {
    gstin: o.gstin, fp: fp(period),
    b2b: Object.values(b2b.reduce((acc: Row, i) => {
      (acc[i.ctin] ??= { ctin: i.ctin, inv: [] }).inv.push({ inum: i.inum, idt: i.idt, val: i.val, pos: i.pos, rchrg: i.rchrg, inv_typ: i.inv_typ, itms: i.itms.map((t: Row, n: number) => ({ num: n + 1, itm_det: { rt: t.rt, txval: t.txval, iamt: t.iamt, camt: t.camt, samt: t.samt, csamt: 0 } })) });
      return acc;
    }, {})),
    b2cl: Object.values(b2cl.reduce((acc: Row, i) => {
      (acc[i.pos] ??= { pos: i.pos, inv: [] }).inv.push({ inum: i.inum, idt: i.idt, val: i.val, itms: i.itms.map((t: Row, n: number) => ({ num: n + 1, itm_det: { rt: t.rt, txval: t.txval, iamt: t.iamt, csamt: 0 } })) });
      return acc;
    }, {})),
    b2cs: b2csRows.map((r) => ({ ...r, csamt: 0 })),
    exp: Object.values(exp.reduce((acc: Row, i) => {
      (acc[i.exp_typ] ??= { exp_typ: i.exp_typ, inv: [] }).inv.push({ inum: i.inum, idt: i.idt, val: i.val, sbpcode: '', sbnum: i.sbpnum, sbdt: i.sbpdt, itms: i.itms.map((t: Row) => ({ rt: t.rt, txval: t.txval, iamt: t.iamt, csamt: 0 })) });
      return acc;
    }, {})),
    cdnr: Object.values(cdnr.reduce((acc: Row, i) => {
      (acc[i.ctin] ??= { ctin: i.ctin, nt: [] }).nt.push({ ntty: i.ntty, nt_num: i.nt_num, nt_dt: i.nt_dt, val: i.val, pos: i.pos, rchrg: i.rchrg, inv_typ: i.inv_typ, itms: i.itms.map((t: Row, n: number) => ({ num: n + 1, itm_det: { rt: t.rt, txval: t.txval, iamt: t.iamt, camt: t.camt, samt: t.samt, csamt: 0 } })) });
      return acc;
    }, {})),
    cdnur: cdnur.map((i) => ({ typ: i.typ, ntty: i.ntty, nt_num: i.nt_num, nt_dt: i.nt_dt, val: i.val, pos: i.pos, itms: i.itms.map((t: Row, n: number) => ({ num: n + 1, itm_det: { rt: t.rt, txval: t.txval, iamt: t.iamt, csamt: 0 } })) })),
    hsn: {
      hsn_b2b: hsnRows.filter((h) => h.section === 'b2b').map((h, n) => ({ num: n + 1, hsn_sc: h.hsn_sc, desc: h.desc, uqc: h.uqc, qty: h.qty, rt: h.rt, txval: h.txval, iamt: h.iamt, camt: h.camt, samt: h.samt, csamt: 0 })),
      hsn_b2c: hsnRows.filter((h) => h.section === 'b2c').map((h, n) => ({ num: n + 1, hsn_sc: h.hsn_sc, desc: h.desc, uqc: h.uqc, qty: h.qty, rt: h.rt, txval: h.txval, iamt: h.iamt, camt: h.camt, samt: h.samt, csamt: 0 })),
    },
    nil: { inv: Object.entries(nil).map(([k, v]) => ({ sply_ty: ({ inter_reg: 'INTRB2B', intra_reg: 'INTRAB2B', inter_unreg: 'INTRB2C', intra_unreg: 'INTRAB2C' } as Row)[k], nil_amt: v.nil, expt_amt: v.exempt, ngsup_amt: v.ngsup })) },
    doc_issue: { doc_det: [...docSeries(allInv, 'Invoices for outward supply', 1), ...docSeries(allCn, 'Credit Note', 5)] },
  };
  return { period, gstin: o.gstin, summary, b2b, b2cl, b2cs: b2csRows, exp, cdnr, cdnur, hsn: hsnRows, nil, docs: gstn.doc_issue.doc_det, json: gstn };
}

export function gstr3b(period: string) {
  const { from, to } = range(period);
  const o = org();
  const inv = docsWithLines(['invoice'], from, to);
  const cn = docsWithLines(['credit_note'], from, to);
  const bills = docsWithLines(['bill'], from, to);
  const recorded = db().all<Row>(`SELECT doc.*, c.gst_treatment AS c_treatment FROM documents doc LEFT JOIN contacts c ON c.id = doc.contact_id WHERE doc.type = 'expense' AND doc.status = 'recorded' AND doc.date BETWEEN ? AND ?`, from, to);
  const expenses = recorded.map((doc) => ({ ...doc, data: json(doc.data, {}), lines: db().all<Row>('SELECT * FROM document_lines WHERE document_id = ?', doc.id) }));
  const vcs = docsWithLines(['vendor_credit'], from, to);
  const zero = () => ({ txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
  const t31 = { a: zero(), b: zero(), c: zero(), d: zero(), e: zero() };
  const t32 = new Map<string, Row>();
  const add = (bucket: Row, l: Row, ex: number, sign: number, taxes = true) => {
    bucket.txval = r2(bucket.txval + sign * l.taxable * ex);
    if (taxes) {
      bucket.iamt = r2(bucket.iamt + sign * l.igst * ex);
      bucket.camt = r2(bucket.camt + sign * l.cgst * ex);
      bucket.samt = r2(bucket.samt + sign * l.sgst * ex);
    }
  };
  for (const [docs, sign] of [[inv, 1], [cn, -1]] as [Row[], number][]) {
    for (const doc of docs) {
      const ex = doc.exchange_rate || 1;
      for (const l of doc.lines) {
        if (doc.c_treatment === 'overseas' || doc.c_treatment === 'sez') add(t31.b, l, ex, sign);
        else if (l.tax_exempt === 'non_gst') add(t31.e, l, ex, sign, false);
        else if (l.tax_exempt === 'nil' || l.tax_exempt === 'exempt' || !l.tax_rate) add(t31.c, l, ex, sign, false);
        else add(t31.a, l, ex, sign);
        if (!isB2B(doc.c_treatment) && doc.c_treatment !== 'overseas' && doc.place_of_supply !== o.state_code && l.tax_rate) {
          const cur = t32.get(doc.place_of_supply) ?? { pos: doc.place_of_supply, state: STATES[doc.place_of_supply], txval: 0, iamt: 0 };
          cur.txval = r2(cur.txval + sign * l.taxable * ex);
          cur.iamt = r2(cur.iamt + sign * l.igst * ex);
          t32.set(doc.place_of_supply, cur);
        }
      }
    }
  }
  const itc = { rcm: zero(), others: zero(), ineligible: zero(), reversed: zero() };
  const exemptIn = { inter: 0, intra: 0, ngst_inter: 0, ngst_intra: 0 };
  for (const [docs, sign] of [[[...bills, ...expenses], 1], [vcs, -1]] as [Row[], number][]) {
    for (const doc of docs) {
      const ex = doc.exchange_rate || 1;
      const inter = doc.place_of_supply !== o.state_code;
      for (const l of doc.lines) {
        if (doc.reverse_charge && l.tax_rate) add(t31.d, l, ex, sign);
        if (l.tax_exempt === 'nil' || l.tax_exempt === 'exempt' || (!l.tax_rate && !doc.reverse_charge && doc.c_treatment !== 'overseas')) {
          exemptIn[inter ? 'inter' : 'intra'] = r2(exemptIn[inter ? 'inter' : 'intra'] + sign * l.taxable * ex);
        } else if (l.tax_exempt === 'non_gst') exemptIn[inter ? 'ngst_inter' : 'ngst_intra'] = r2(exemptIn[inter ? 'ngst_inter' : 'ngst_intra'] + sign * l.taxable * ex);
        if (!l.tax_rate) continue;
        const bucket = !l.itc_eligible ? itc.ineligible : doc.reverse_charge ? itc.rcm : itc.others;
        add(bucket, l, ex, sign);
      }
    }
  }
  const netItc = { iamt: r2(itc.rcm.iamt + itc.others.iamt), camt: r2(itc.rcm.camt + itc.others.camt), samt: r2(itc.rcm.samt + itc.others.samt) };
  // Forward-charge liability can be set off against ITC; reverse-charge tax must be paid in cash.
  const fwd = { igst: r2(t31.a.iamt + t31.b.iamt), cgst: r2(t31.a.camt), sgst: r2(t31.a.samt) };
  const setoff = gstSetOff(fwd, { igst: netItc.iamt, cgst: netItc.camt, sgst: netItc.samt });
  const rcmCash = { igst: t31.d.iamt, cgst: t31.d.camt, sgst: t31.d.samt };
  const cash = { igst: r2(setoff.cash.igst + rcmCash.igst), cgst: r2(setoff.cash.cgst + rcmCash.cgst), sgst: r2(setoff.cash.sgst + rcmCash.sgst) };
  return {
    period, gstin: o.gstin,
    table_3_1: [
      { row: '(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', ...t31.a },
      { row: '(b) Outward taxable supplies (zero rated)', ...t31.b },
      { row: '(c) Other outward supplies (nil rated, exempted)', ...t31.c },
      { row: '(d) Inward supplies (liable to reverse charge)', ...t31.d },
      { row: '(e) Non-GST outward supplies', ...t31.e },
    ],
    table_3_2: [...t32.values()],
    table_4: [
      { row: '(A)(3) Inward supplies liable to reverse charge', ...itc.rcm },
      { row: '(A)(5) All other ITC', ...itc.others },
      { row: '(C) Net ITC available (A) - (B)', txval: 0, ...netItc, csamt: 0 },
      { row: '(D)(1) Ineligible ITC as per section 17(5) / others', ...itc.ineligible },
    ],
    table_5: [
      { row: 'From a supplier under composition scheme, exempt and nil rated supply', inter: exemptIn.inter, intra: exemptIn.intra },
      { row: 'Non GST supply', inter: exemptIn.ngst_inter, intra: exemptIn.ngst_intra },
    ],
    liability: { forward: fwd, reverse_charge: rcmCash },
    itc: netItc,
    setoff,
    cash_payable: cash,
    total_cash: r2(cash.igst + cash.cgst + cash.sgst),
    due_date: `${nextMonth(period)}-20`,
  };
}
const nextMonth = (p: string) => {
  const [y, m] = p.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/** Matches GSTR-2B entries (supplier GSTIN + invoice number) against recorded bills. */
export function reconcile2b(period: string, entries: Row[]) {
  const { from, to } = range(period);
  const bills = db().all<Row>(
    `SELECT doc.id, doc.number, doc.reference, doc.date, doc.taxable_total, doc.igst_total, doc.cgst_total, doc.sgst_total, doc.total, doc.data, c.gstin, c.name
     FROM documents doc JOIN contacts c ON c.id = doc.contact_id WHERE doc.type = 'bill' AND doc.status IN ${LIVE} AND doc.date BETWEEN ? AND ?`, from, to)
    .map((b) => ({ ...b, vendor_invoice: json<Row>(b.data, {}).vendor_invoice_no || b.reference || b.number }));
  const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const used = new Set<number>();
  const results = entries.map((e) => {
    const bill = bills.find((b) => !used.has(b.id) && norm(b.gstin) === norm(e.ctin) && norm(b.vendor_invoice) === norm(e.inum));
    if (!bill) return { ...e, status: 'missing_in_books' };
    used.add(bill.id);
    const diffs: string[] = [];
    const tx = r2(Number(e.txval ?? 0)), tax = r2(Number(e.iamt ?? 0) + Number(e.camt ?? 0) + Number(e.samt ?? 0));
    if (Math.abs(tx - bill.taxable_total) > 1) diffs.push(`Taxable value: 2B ₹${tx} vs books ₹${bill.taxable_total}`);
    if (Math.abs(tax - r2(bill.igst_total + bill.cgst_total + bill.sgst_total)) > 1) diffs.push(`Tax: 2B ₹${tax} vs books ₹${r2(bill.igst_total + bill.cgst_total + bill.sgst_total)}`);
    return { ...e, bill_id: bill.id, bill_number: bill.number, status: diffs.length ? 'mismatch' : 'matched', differences: diffs };
  });
  const missingIn2b = bills.filter((b) => !used.has(b.id)).map((b) => ({ ctin: b.gstin, name: b.name, inum: b.vendor_invoice, bill_id: b.id, bill_number: b.number, txval: b.taxable_total, status: 'missing_in_2b' }));
  return {
    period, results: [...results, ...missingIn2b],
    summary: {
      matched: results.filter((r) => r.status === 'matched').length, mismatch: results.filter((r) => r.status === 'mismatch').length,
      missing_in_books: results.filter((r) => r.status === 'missing_in_books').length, missing_in_2b: missingIn2b.length,
    },
  };
}
