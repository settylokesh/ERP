import { audit } from './activity.js';
import type { AuthUser } from './auth.js';
import { db, fail, json, type Row } from './db.js';
import { loadFull } from './documents/posting.js';
import { org } from './settings.js';
import { addDays, isPincode, isRegistered, r2, round, validateGstin } from './util.js';

/**
 * GST e-invoicing and e-way bills.
 *
 * The application prepares the government JSON and records what the portals return; it does not call the IRP or the
 * e-way bill system itself (that needs GSP/API credentials issued to the taxpayer). The workflow is:
 *   1. Export the IRN request (e-invoice schema version 1.1) or the e-way bill bulk-generation JSON.
 *   2. Upload it on the IRP / e-way bill portal (or send it through a GSP).
 *   3. Record the IRN, acknowledgement and signed QR code (or the e-way bill number) against the document.
 *
 * Field names follow the NIC e-invoice schema (INV-01, version 1.1) and the e-way bill bulk JSON format.
 */

const fmtDate = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');
const r3 = (n: number) => round(n, 3);

/** GST rule 46: up to 16 characters, starting with a letter or digit, using only letters, digits, '-' and '/'. */
export const GST_DOC_NUMBER = /^[A-Za-z0-9][A-Za-z0-9/-]{0,15}$/;

/** Unit Quantity Codes (UQC) accepted by the IRP and e-way bill system, keyed by common unit spellings. */
const UQC: Record<string, string> = {
  pcs: 'PCS', pc: 'PCS', piece: 'PCS', pieces: 'PCS', nos: 'NOS', no: 'NOS', number: 'NOS', numbers: 'NOS', unit: 'UNT', units: 'UNT',
  kg: 'KGS', kgs: 'KGS', kilogram: 'KGS', g: 'GMS', gm: 'GMS', gms: 'GMS', gram: 'GMS', ton: 'TON', tonne: 'TON', mt: 'MTS', qtl: 'QTL',
  l: 'LTR', lt: 'LTR', ltr: 'LTR', litre: 'LTR', liter: 'LTR', ml: 'MLT', kl: 'KLR', m: 'MTR', mtr: 'MTR', meter: 'MTR', metre: 'MTR',
  cm: 'CMS', km: 'KME', sqm: 'SQM', sqft: 'SQF', sqf: 'SQF', sqy: 'SQY', cbm: 'CBM', ccm: 'CCM', yd: 'YDS', yds: 'YDS',
  box: 'BOX', boxes: 'BOX', bag: 'BAG', bags: 'BAG', bale: 'BAL', bdl: 'BDL', bundle: 'BDL', btl: 'BTL', bottle: 'BTL', can: 'CAN',
  ctn: 'CTN', carton: 'CTN', doz: 'DOZ', dozen: 'DOZ', drm: 'DRM', drum: 'DRM', pac: 'PAC', pack: 'PAC', pair: 'PRS', prs: 'PRS',
  roll: 'ROL', rol: 'ROL', set: 'SET', sets: 'SET', tab: 'TBS', tablet: 'TBS', tube: 'TUB', gross: 'GRS', thd: 'THD',
};
export const uqc = (unit: string | null | undefined) => {
  const u = String(unit ?? '').trim();
  if (/^[A-Z]{3}$/.test(u) && Object.values(UQC).includes(u)) return u;
  return UQC[u.toLowerCase()] ?? 'OTH';
};

function splitAddress(text: string | null | undefined): [string, string] {
  const parts = String(text ?? '').split(/\r?\n|,\s*/).map((s) => s.trim()).filter(Boolean);
  const a1: string[] = [];
  const a2: string[] = [];
  for (const p of parts) (a1.join(', ').length + p.length < 95 ? a1 : a2).push(p);
  return [a1.join(', ').slice(0, 100), a2.join(', ').slice(0, 100)];
}

/** Document lines in rupees with the gross / discount split the schemas expect. */
function lineValues(doc: Row, l: Row) {
  const ex = doc.exchange_rate || 1;
  const taxable = r2(l.taxable * ex);
  const pct = Number(l.discount_pct) || 0;
  const grossFc = pct > 0 && pct < 100 ? l.taxable / (1 - pct / 100) : l.taxable;
  const gross = r2(grossFc * ex);
  return {
    taxable, gross, discount: r2(gross - taxable), unitPrice: l.qty ? r3(gross / l.qty) : 0,
    cgst: r2(l.cgst * ex), sgst: r2(l.sgst * ex), igst: r2(l.igst * ex),
  };
}

/** Services: service items, or SAC codes (chapter 99). */
export const isService = (l: Row) => l.item_type === 'service' || String(l.hsn_code ?? '').startsWith('99');

function sellerDetails(problems: string[]) {
  const o = org();
  const gErr = validateGstin(o.gstin);
  if (gErr) problems.push(`Organisation ${gErr} (Settings > Organisation)`);
  if (!o.address) problems.push('Organisation address is missing (Settings > Organisation)');
  if (!o.city) problems.push('Organisation city is missing (Settings > Organisation)');
  if (!isPincode(o.pincode)) problems.push('Organisation PIN code must be 6 digits (Settings > Organisation)');
  const [a1, a2] = splitAddress(o.address);
  return {
    o,
    seller: {
      Gstin: o.gstin, LglNm: o.legal_name || o.name, TrdNm: o.name, Addr1: a1, ...(a2 ? { Addr2: a2 } : {}), Loc: o.city,
      Pin: Number(o.pincode), Stcd: o.state_code, ...(o.phone ? { Ph: o.phone.replace(/\D/g, '').slice(-12) } : {}), ...(o.email ? { Em: o.email } : {}),
    },
  };
}

function checkHsn(lines: Row[], problems: string[]) {
  for (const l of lines) {
    if (!/^(\d{4}|\d{6}|\d{8})$/.test(String(l.hsn_code ?? ''))) problems.push(`Line ${l.line_no} "${l.description || l.item_name}": HSN/SAC must have 4, 6 or 8 digits`);
  }
}

function assertEinvoiceApplicable(doc: Row): Row {
  if (!['invoice', 'credit_note'].includes(doc.type)) fail('e-Invoices apply to invoices and credit notes only', 422);
  if (['draft', 'pending_approval', 'void', 'rejected'].includes(doc.status)) fail('Only issued documents can be e-invoiced', 422);
  const contact = db().get<Row>('SELECT * FROM contacts WHERE id = ?', doc.contact_id) ?? fail('Customer not found', 422);
  if (!(isRegistered(contact.gst_treatment) || contact.gst_treatment === 'overseas')) {
    fail('e-Invoicing covers B2B, SEZ, deemed-export and export supplies. This customer is unregistered (B2C).', 422);
  }
  return contact;
}

/** Builds the IRP "generate IRN" request (schema 1.1) for an invoice or credit note. */
export function einvoicePayload(docId: number) {
  const doc = loadFull(docId) ?? fail('Document not found', 404);
  const contact = assertEinvoiceApplicable(doc);
  const t = contact.gst_treatment;
  const problems: string[] = [];
  const { seller } = sellerDetails(problems);
  if (!GST_DOC_NUMBER.test(doc.number)) problems.push(`Document number ${doc.number} must be at most 16 characters of letters, digits, '-' or '/' (Settings > Numbering)`);
  checkHsn(doc.lines, problems);

  const overseas = t === 'overseas';
  const withTax = doc.igst_total > 0 || doc.cgst_total > 0;
  const SupTyp = t === 'sez' ? (withTax ? 'SEZWP' : 'SEZWOP') : overseas ? (withTax ? 'EXPWP' : 'EXPWOP') : t === 'deemed_export' ? 'DEXP' : 'B2B';
  if (!overseas) {
    const cErr = validateGstin(contact.gstin);
    if (cErr) problems.push(`Customer ${cErr}`);
  }
  const buyerState = overseas ? '96' : (contact.gstin ? contact.gstin.slice(0, 2) : contact.billing_state || doc.place_of_supply);
  const buyerPin = overseas ? '999999' : String(contact.billing_pincode ?? '');
  if (!contact.billing_address) problems.push('Customer billing address is missing');
  if (!overseas && !contact.billing_city) problems.push('Customer billing city is missing');
  if (!isPincode(buyerPin)) problems.push('Customer billing PIN code must be 6 digits');
  if (overseas && !/^[A-Z]{2}$/.test(contact.billing_country ?? '')) problems.push('Customer country (2-letter ISO code, e.g. AE) is required for exports');
  if (problems.length) fail(`The e-invoice cannot be prepared:\n• ${problems.join('\n• ')}`, 422, { problems });

  const [b1, b2] = splitAddress(contact.billing_address);
  const items = doc.lines.map((l, i) => {
    const v = lineValues(doc, l);
    const service = isService(l);
    return {
      SlNo: String(i + 1), PrdDesc: String(l.description || l.item_name || '').slice(0, 300), IsServc: service ? 'Y' : 'N', HsnCd: String(l.hsn_code),
      Qty: r3(l.qty), FreeQty: 0, ...(service ? {} : { Unit: uqc(l.unit) }), UnitPrice: v.unitPrice, TotAmt: v.gross, Discount: v.discount,
      PreTaxVal: 0, AssAmt: v.taxable, GstRt: Number(l.tax_rate) || 0, IgstAmt: v.igst, CgstAmt: v.cgst, SgstAmt: v.sgst,
      CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0, OthChrg: 0,
      TotItemVal: r2(v.taxable + v.cgst + v.sgst + v.igst),
    };
  });
  const ex = doc.exchange_rate || 1;
  const sum = (k: keyof (typeof items)[number]) => r2(items.reduce((a, x) => a + Number(x[k]), 0));
  const payload: Row = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp, RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: doc.type === 'credit_note' ? 'CRN' : 'INV', No: doc.number, Dt: fmtDate(doc.date) },
    SellerDtls: seller,
    BuyerDtls: {
      Gstin: overseas ? 'URP' : contact.gstin, LglNm: contact.company_name || contact.name, TrdNm: contact.company_name || contact.name,
      Pos: overseas ? '96' : doc.place_of_supply, Addr1: b1, ...(b2 ? { Addr2: b2 } : {}), Loc: overseas ? (contact.billing_city || 'Overseas') : contact.billing_city,
      Pin: Number(buyerPin), Stcd: buyerState, ...(contact.phone ? { Ph: contact.phone.replace(/\D/g, '').slice(-12) } : {}), ...(contact.email ? { Em: contact.email } : {}),
    },
    ItemList: items,
    ValDtls: {
      AssVal: sum('AssAmt'), CgstVal: sum('CgstAmt'), SgstVal: sum('SgstAmt'), IgstVal: sum('IgstAmt'), CesVal: 0, StCesVal: 0,
      Discount: 0, OthChrg: 0, RndOffAmt: r2((doc.adjustment || 0) * ex), TotInvVal: r2(doc.total * ex),
      ...(doc.currency_code !== 'INR' ? { TotInvValFc: r2(doc.total) } : {}),
    },
  };
  if (overseas) payload.ExpDtls = { CntCode: contact.billing_country, ...(doc.currency_code !== 'INR' ? { ForCur: doc.currency_code } : {}) };
  if (doc.type === 'credit_note') {
    const original = originalInvoice(doc);
    if (original) payload.RefDtls = { PrecDocDtls: [{ InvNo: original.number, InvDt: fmtDate(original.date) }] };
  }
  return { document: { id: doc.id, type: doc.type, number: doc.number }, payload };
}

function originalInvoice(doc: Row): Row | null {
  let id = doc.ref_doc_id;
  for (let i = 0; id && i < 3; i++) {
    const p = db().get<Row>('SELECT id, type, number, date, ref_doc_id FROM documents WHERE id = ?', id);
    if (!p) return null;
    if (p.type === 'invoice') return p;
    id = p.ref_doc_id;
  }
  return null;
}

export const TRANSPORT_MODES: Record<string, number> = { road: 1, rail: 2, air: 3, ship: 4 };
/** Sub-supply types of the e-way bill system used for delivery challans. */
export const CHALLAN_SUB_TYPES: Record<string, number> = {
  'Job Work': 4, 'Supply on Approval': 8, 'For Own Use': 5, 'Branch Transfer': 5, 'Exhibition or Fairs': 12, 'SKD/CKD': 9,
  'Line Sales': 10, 'Recipient Not Known': 11, Others: 8,
};

/** e-Way bill validity per Rule 138(10): 1 day per 200 km (20 km for over-dimensional cargo), ending at midnight. */
export function ewayValidity(generatedOn: string, distanceKm: number, odc = false) {
  const days = Math.max(1, Math.ceil(distanceKm / (odc ? 20 : 200)));
  return { days, valid_until: `${addDays(generatedOn.slice(0, 10), days)}T23:59:59` };
}

const VEHICLE_NO = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$|^TM[A-Z0-9]{6}$/;

export interface Transport {
  distance?: number;
  transport_mode?: string;
  vehicle_no?: string;
  vehicle_type?: 'regular' | 'odc';
  transporter_id?: string;
  transporter_name?: string;
  transport_doc_no?: string;
  transport_doc_date?: string;
}

function cleanTransport(t: Transport, problems: string[]) {
  const distance = Math.round(Number(t.distance));
  if (!(distance >= 1 && distance <= 4000)) problems.push('Approximate distance must be between 1 and 4000 km');
  const mode = t.transport_mode ? String(t.transport_mode).toLowerCase() : '';
  if (mode && !TRANSPORT_MODES[mode]) problems.push('Mode of transport must be road, rail, air or ship');
  const vehicle = String(t.vehicle_no ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (vehicle && !VEHICLE_NO.test(vehicle)) problems.push('Vehicle number format is invalid (e.g. KA01AB1234)');
  const transporterId = String(t.transporter_id ?? '').toUpperCase().trim();
  if (transporterId && !/^[0-9A-Z]{15}$/.test(transporterId)) problems.push('Transporter ID must be a 15-character GSTIN/TRANSIN');
  if ((mode === 'rail' || mode === 'air' || mode === 'ship') && !t.transport_doc_no) problems.push('Transport document number is required for rail, air or ship');
  if (mode === 'road' && !vehicle && !transporterId) problems.push('Enter a vehicle number or a transporter ID');
  if (t.transport_doc_date && !/^\d{4}-\d{2}-\d{2}$/.test(t.transport_doc_date)) problems.push('Transport document date is invalid');
  return { distance, mode, vehicle, transporterId, odc: t.vehicle_type === 'odc' };
}

/** Builds one entry of the e-way bill bulk-generation JSON for an invoice, delivery challan or credit note (inward return). */
export function ewaybillPayload(docId: number, transport: Transport) {
  const doc = loadFull(docId) ?? fail('Document not found', 404);
  if (!['invoice', 'delivery_challan', 'credit_note'].includes(doc.type)) fail('e-Way bills apply to invoices, delivery challans and credit notes', 422);
  if (['draft', 'pending_approval', 'void', 'rejected', 'returned'].includes(doc.status)) fail('Only issued documents can have an e-way bill', 422);
  const goods = doc.lines.filter((l) => !isService(l));
  if (!goods.length) fail('e-Way bills are only needed for the movement of goods', 422);
  const contact = db().get<Row>('SELECT * FROM contacts WHERE id = ?', doc.contact_id)!;
  const problems: string[] = [];
  const { o } = sellerDetails(problems);
  checkHsn(goods, problems);
  const tr = cleanTransport(transport, problems);
  const overseas = contact.gst_treatment === 'overseas';
  const shipPin = String((contact.shipping_address ? contact.shipping_pincode : null) || contact.billing_pincode || '');
  if (!isPincode(shipPin)) problems.push(overseas ? 'Enter the PIN code of the port of export as the customer shipping PIN code' : 'Customer PIN code must be 6 digits');
  if (problems.length) fail(`The e-way bill cannot be prepared:\n• ${problems.join('\n• ')}`, 422, { problems });

  const wh = doc.warehouse_id ? db().get<Row>('SELECT * FROM warehouses WHERE id = ?', doc.warehouse_id) : null;
  const ourAddr = splitAddress(wh?.address || o.address);
  const ourPlace = wh?.city || o.city;
  const ourPin = Number((isPincode(wh?.pincode) ? wh!.pincode : null) || o.pincode);
  const ourState = Number(wh?.state_code || o.state_code);
  const partyAddr = splitAddress(contact.shipping_address || contact.billing_address);
  const partyPlace = (contact.shipping_address ? contact.shipping_city : null) || contact.billing_city || '';
  const partyGstin = !overseas && contact.gstin ? contact.gstin : 'URP';
  const partyBillState = overseas ? 96 : Number(contact.gstin ? contact.gstin.slice(0, 2) : doc.place_of_supply);
  const partyShipState = Number((contact.shipping_address ? contact.shipping_state : null) || contact.billing_state || (overseas ? o.state_code : partyBillState));

  const inward = doc.type === 'credit_note';
  const challanType = json<Row>(doc.data, {}).challan_type ?? 'Job Work';
  const withTax = doc.igst_total > 0 || doc.cgst_total > 0;
  let subSupplyType = 1;
  let docType = 'INV';
  if (doc.type === 'delivery_challan') { subSupplyType = CHALLAN_SUB_TYPES[challanType] ?? 8; docType = 'CHL'; }
  if (inward) { subSupplyType = 7; docType = 'CHL'; }
  if (doc.type === 'invoice' && overseas) { subSupplyType = 3; if (!withTax) docType = 'BIL'; }
  if (doc.type === 'invoice' && !withTax && doc.lines.every((l) => l.tax_exempt && l.tax_exempt !== 'zero_rated')) docType = 'BIL';

  const ex = doc.exchange_rate || 1;
  const items = goods.map((l, i) => {
    const v = lineValues(doc, l);
    const half = (Number(l.tax_rate) || 0) / 2;
    return {
      itemNo: i + 1, productName: String(l.item_name || l.description).slice(0, 100), productDesc: String(l.description || l.item_name).slice(0, 100),
      hsnCode: Number(l.hsn_code), quantity: r3(l.qty), qtyUnit: uqc(l.unit), taxableAmount: v.taxable,
      sgstRate: l.sgst ? half : 0, cgstRate: l.cgst ? half : 0, igstRate: l.igst ? Number(l.tax_rate) || 0 : 0, cessRate: 0, cessNonAdvol: 0,
    };
  });
  const mainHsn = [...goods].sort((a, b) => b.taxable - a.taxable)[0].hsn_code;
  const us = { gstin: o.gstin, name: o.legal_name || o.name, addr: ourAddr, place: ourPlace, pin: ourPin, state: Number(o.state_code), actState: ourState };
  const them = { gstin: partyGstin, name: contact.company_name || contact.name, addr: partyAddr, place: partyPlace, pin: Number(shipPin), state: partyBillState, actState: partyShipState };
  const [from, to] = inward ? [them, us] : [us, them];
  const r = (x: number) => r2(x * ex);
  const entry: Row = {
    userGstin: o.gstin, supplyType: inward ? 'I' : 'O', subSupplyType, subSupplyDesc: subSupplyType === 8 ? challanType : '', docType,
    docNo: doc.number, docDate: fmtDate(doc.date), transType: 1,
    fromGstin: from.gstin, fromTrdName: from.name, fromAddr1: from.addr[0], fromAddr2: from.addr[1], fromPlace: from.place, fromPincode: from.pin,
    fromStateCode: from.state, actualFromStateCode: from.actState,
    toGstin: to.gstin, toTrdName: to.name, toAddr1: to.addr[0], toAddr2: to.addr[1], toPlace: to.place, toPincode: to.pin,
    toStateCode: to.state, actualToStateCode: to.actState,
    totalValue: r2(items.reduce((a, x) => a + x.taxableAmount, 0)),
    cgstValue: r(goods.reduce((a, l) => a + l.cgst, 0)), sgstValue: r(goods.reduce((a, l) => a + l.sgst, 0)), igstValue: r(goods.reduce((a, l) => a + l.igst, 0)),
    cessValue: 0, TotNonAdvolVal: 0, OthValue: 0,
    totInvValue: r(goods.reduce((a, l) => a + l.taxable + l.cgst + l.sgst + l.igst, 0)),
    transMode: tr.mode ? TRANSPORT_MODES[tr.mode] : '', transDistance: tr.distance, transporterId: tr.transporterId, transporterName: transport.transporter_name ?? '',
    transDocNo: transport.transport_doc_no ?? '', transDocDate: transport.transport_doc_date ? fmtDate(transport.transport_doc_date) : '',
    vehicleNo: tr.vehicle, vehicleType: tr.vehicle ? (tr.odc ? 'O' : 'R') : '', mainHsnCode: Number(mainHsn), itemList: items,
  };
  return { document: { id: doc.id, type: doc.type, number: doc.number }, entry, transport: tr };
}

/** The e-way bill portal's bulk upload file: one or more entries under billLists. */
export const ewaybillBulkFile = (entries: Row[]) => ({ version: '1.0.0621', billLists: entries });

// ---------- Recording what the portals return ----------

const docData = (doc: Row) => json<Row>(doc.data, {});
const updateData = (id: number, patch: Row) => {
  const doc = db().get<Row>('SELECT data FROM documents WHERE id = ?', id)!;
  db().update('documents', id, { data: JSON.stringify({ ...json<Row>(doc.data, {}), ...patch }) });
};

export function recordIrn(doc: Row, body: Row, user?: AuthUser) {
  if (!org().einvoice_enabled) fail('Turn on e-invoicing in Settings > Organisation first', 422);
  if (docData(doc).einvoice?.status === 'generated') fail('An IRN is already recorded for this document', 422);
  assertEinvoiceApplicable(doc);
  const irn = String(body.irn ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(irn)) fail('IRN must be the 64-character code returned by the IRP', 422);
  const ackNo = String(body.ack_no ?? '').trim();
  if (!/^\d{10,20}$/.test(ackNo)) fail('Acknowledgement number must be the numeric value returned by the IRP', 422);
  const ackDate = String(body.ack_date ?? '').trim();
  if (Number.isNaN(Date.parse(ackDate))) fail('Acknowledgement date is invalid', 422);
  if (db().get(`SELECT 1 FROM documents WHERE id <> ? AND json_extract(data, '$.einvoice.irn') = ? AND json_extract(data, '$.einvoice.status') = 'generated'`, doc.id, irn)) {
    fail('This IRN is already recorded on another document', 409);
  }
  const signedQr = body.signed_qr ? String(body.signed_qr).trim() : null;
  updateData(doc.id, { einvoice: { status: 'generated', irn, ack_no: ackNo, ack_date: new Date(ackDate).toISOString(), signed_qr: signedQr, recorded_at: new Date().toISOString(), recorded_by: user?.id ?? null } });
  audit(doc.type, doc.id, 'einvoice', `IRN recorded (Ack ${ackNo})`, user);
}

const IRN_CANCEL_REASONS: Record<string, string> = { 1: 'Duplicate', 2: 'Data entry mistake', 3: 'Order cancelled', 4: 'Others' };
export function cancelIrn(doc: Row, body: Row, user?: AuthUser) {
  const e = docData(doc).einvoice;
  if (e?.status !== 'generated') fail('No active IRN to cancel', 422);
  if (Date.now() - Date.parse(e.ack_date) > 24 * 3600 * 1000) fail('An IRN can only be cancelled on the IRP within 24 hours of generation. Issue a credit note instead.', 422);
  const code = String(body.reason_code ?? '2');
  if (!IRN_CANCEL_REASONS[code]) fail('Invalid cancellation reason', 422);
  updateData(doc.id, { einvoice: { ...e, status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason_code: code, cancel_reason: IRN_CANCEL_REASONS[code], cancel_remarks: body.remarks ?? '' } });
  audit(doc.type, doc.id, 'einvoice', `IRN marked cancelled: ${IRN_CANCEL_REASONS[code]}`, user);
}

export function recordEwb(doc: Row, body: Row, user?: AuthUser) {
  if (docData(doc).ewaybill?.status === 'generated') fail('An e-way bill is already recorded for this document', 422);
  if (!['invoice', 'delivery_challan', 'credit_note'].includes(doc.type)) fail('e-Way bills apply to invoices, delivery challans and credit notes', 422);
  const problems: string[] = [];
  const transport = cleanTransport(body, problems);
  if (problems.length) fail(problems.join('. '), 422, { problems });
  const ewbNo = String(body.ewb_no ?? '').replace(/\s/g, '');
  if (!/^\d{12}$/.test(ewbNo)) fail('e-Way bill number must be the 12-digit number from the e-way bill portal', 422);
  const generatedAt = String(body.ewb_date ?? new Date().toISOString());
  if (Number.isNaN(Date.parse(generatedAt))) fail('e-Way bill date is invalid', 422);
  if (db().get(`SELECT 1 FROM documents WHERE id <> ? AND json_extract(data, '$.ewaybill.ewb_no') = ? AND json_extract(data, '$.ewaybill.status') = 'generated'`, doc.id, ewbNo)) {
    fail('This e-way bill number is already recorded on another document', 409);
  }
  if (body.valid_until && Number.isNaN(Date.parse(String(body.valid_until)))) fail('Valid-until date is invalid', 422);
  const partB = !!transport.vehicle || (transport.mode && transport.mode !== 'road');
  const validity = ewayValidity(generatedAt, transport.distance, transport.odc);
  updateData(doc.id, {
    ewaybill: {
      status: 'generated', ewb_no: ewbNo, generated_at: new Date(generatedAt).toISOString(),
      valid_until: body.valid_until ? new Date(String(body.valid_until)).toISOString() : partB ? validity.valid_until : null, validity_days: validity.days,
      distance: transport.distance, transport_mode: transport.mode || 'road', vehicle_no: transport.vehicle || null, odc: transport.odc,
      transporter_id: transport.transporterId || null, transporter_name: body.transporter_name ?? null, transport_doc_no: body.transport_doc_no ?? null,
      recorded_by: user?.id ?? null,
    },
  });
  audit(doc.type, doc.id, 'ewaybill', `e-Way bill ${ewbNo} recorded`, user);
}

const VEHICLE_REASONS: Record<string, string> = { 1: 'Due to break down', 2: 'Due to transhipment', 3: 'Others', 4: 'First time' };
export function updateEwbVehicle(doc: Row, body: Row, user?: AuthUser) {
  const e = docData(doc).ewaybill;
  if (e?.status !== 'generated') fail('No active e-way bill', 422);
  if (e.valid_until && Date.now() > Date.parse(e.valid_until)) fail('The e-way bill has expired', 422);
  const vehicle = String(body.vehicle_no ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (!VEHICLE_NO.test(vehicle)) fail('Vehicle number format is invalid (e.g. KA01AB1234)', 422);
  const code = String(body.reason_code ?? (e.vehicle_no ? '2' : '4'));
  if (!VEHICLE_REASONS[code]) fail('Invalid reason for the vehicle update', 422);
  const valid_until = e.valid_until ?? ewayValidity(new Date().toISOString(), e.distance, e.odc).valid_until;
  updateData(doc.id, { ewaybill: { ...e, vehicle_no: vehicle, valid_until, vehicle_history: [...(e.vehicle_history ?? []), { vehicle_no: vehicle, at: new Date().toISOString(), reason: VEHICLE_REASONS[code], remarks: body.remarks ?? '' }] } });
  audit(doc.type, doc.id, 'ewaybill', `e-Way bill Part-B updated with vehicle ${vehicle}`, user);
}

const EWB_CANCEL_REASONS: Record<string, string> = { 1: 'Duplicate', 2: 'Order cancelled', 3: 'Data entry mistake', 4: 'Others' };
export function cancelEwb(doc: Row, body: Row, user?: AuthUser) {
  const e = docData(doc).ewaybill;
  if (e?.status !== 'generated') fail('No active e-way bill', 422);
  if (Date.now() - Date.parse(e.generated_at) > 24 * 3600 * 1000) fail('e-Way bills can only be cancelled within 24 hours of generation', 422);
  const code = String(body.reason_code ?? '3');
  if (!EWB_CANCEL_REASONS[code]) fail('Invalid cancellation reason', 422);
  updateData(doc.id, { ewaybill: { ...e, status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason_code: code, cancel_reason: EWB_CANCEL_REASONS[code], cancel_remarks: body.remarks ?? '' } });
  audit(doc.type, doc.id, 'ewaybill', `e-Way bill ${e.ewb_no} marked cancelled`, user);
}
