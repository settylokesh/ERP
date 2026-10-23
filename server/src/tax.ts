import { r2 } from './util.js';

export interface TaxLineInput {
  qty: number;
  rate: number;
  discount_pct?: number;
  tax_rate: number;
  tax_exempt?: string | null; // 'exempt' | 'nil' | 'non_gst' | 'zero_rated' | null
}
export interface TaxLineResult {
  gross: number;
  discount: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
  tax_rate: number;
}

export type SupplyKind = 'intra' | 'inter' | 'zero_rated' | 'none';

/**
 * Decides how GST applies to a document.
 *  - intra-state supply (place of supply == our state): CGST + SGST, each half the rate
 *  - inter-state supply: IGST at the full rate
 *  - exports / SEZ under LUT (without payment): zero rated
 *  - imports from overseas vendors without reverse charge: no GST on the vendor bill (IGST is paid at customs)
 */
export function supplyKind(opts: {
  ourState: string;
  placeOfSupply?: string | null;
  gstTreatment?: string | null;
  side: 'sales' | 'purchase';
  withPayment?: boolean;
  reverseCharge?: boolean;
}): SupplyKind {
  const { ourState, placeOfSupply, gstTreatment, side, withPayment, reverseCharge } = opts;
  if (gstTreatment === 'overseas') {
    if (side === 'sales') return withPayment ? 'inter' : 'zero_rated';
    return reverseCharge ? 'inter' : 'none';
  }
  if (gstTreatment === 'sez' && side === 'sales') return withPayment ? 'inter' : 'zero_rated';
  if (side === 'purchase' && (gstTreatment === 'business_none' || gstTreatment === 'business_composition' || gstTreatment === 'consumer') && !reverseCharge) {
    return 'none'; // unregistered / composition suppliers cannot charge GST
  }
  if (!placeOfSupply || placeOfSupply === ourState) return 'intra';
  return 'inter';
}

export function computeTaxLine(l: TaxLineInput, kind: SupplyKind, inclusive = false): TaxLineResult {
  const gross = r2(l.qty * l.rate);
  const discount = r2(gross * (l.discount_pct ?? 0) / 100);
  const net = r2(gross - discount);
  const exempt = !!l.tax_exempt || kind === 'zero_rated' || kind === 'none';
  const rate = exempt ? 0 : l.tax_rate || 0;
  const taxable = inclusive && rate ? r2((net * 100) / (100 + rate)) : net;
  let cgst = 0, sgst = 0, igst = 0;
  if (rate) {
    if (kind === 'intra') {
      cgst = r2(taxable * rate / 200);
      sgst = cgst;
    } else {
      igst = r2(taxable * rate / 100);
    }
  }
  return { gross, discount, taxable, cgst, sgst, igst, tax: r2(cgst + sgst + igst), tax_rate: rate };
}

/** TDS is deducted on the value excluding GST when GST is shown separately (CBDT circular 23/2017). */
export const computeTds = (taxable: number, rate: number) => r2(taxable * rate / 100);

/**
 * GSTR-3B Table 6.1 set-off following Section 49 / Rule 88A:
 * IGST credit is used first (IGST liability, then CGST/SGST), CGST credit against CGST then IGST,
 * SGST credit against SGST then IGST. CGST and SGST credits are never crossed.
 */
export function gstSetOff(liability: { igst: number; cgst: number; sgst: number }, credit: { igst: number; cgst: number; sgst: number }) {
  const L = { ...liability };
  const C = { ...credit };
  const used = {
    igst: { igst: 0, cgst: 0, sgst: 0 },
    cgst: { igst: 0, cgst: 0, sgst: 0 },
    sgst: { igst: 0, cgst: 0, sgst: 0 },
  } as Record<'igst' | 'cgst' | 'sgst', Record<'igst' | 'cgst' | 'sgst', number>>;
  const use = (from: 'igst' | 'cgst' | 'sgst', against: 'igst' | 'cgst' | 'sgst', max = Infinity) => {
    const amt = r2(Math.min(C[from], L[against], max));
    if (amt <= 0) return;
    C[from] = r2(C[from] - amt);
    L[against] = r2(L[against] - amt);
    used[from][against] = r2(used[from][against] + amt);
  };
  use('igst', 'igst');
  // Allocate remaining IGST credit to the head whose own credit falls short first, so less cash is paid overall.
  const shortC = Math.max(0, L.cgst - C.cgst);
  const shortS = Math.max(0, L.sgst - C.sgst);
  use('igst', 'cgst', shortC);
  use('igst', 'sgst', shortS);
  use('igst', 'cgst');
  use('igst', 'sgst');
  use('cgst', 'cgst');
  use('sgst', 'sgst');
  use('cgst', 'igst');
  use('sgst', 'igst');
  return { used, cash: { igst: r2(L.igst), cgst: r2(L.cgst), sgst: r2(L.sgst) }, carry_forward: { igst: r2(C.igst), cgst: r2(C.cgst), sgst: r2(C.sgst) } };
}
