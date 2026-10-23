import { describe, expect, it } from 'vitest';
import { computeTaxLine, computeTds, gstSetOff, supplyKind } from '../src/tax.js';
import { amountInWords, fiscalYear, makeGstin, validateGstin } from '../src/util.js';
import { ewayValidity } from '../src/einvoice.js';

describe('GST computation', () => {
  it('splits intra-state tax into equal CGST and SGST', () => {
    const r = computeTaxLine({ qty: 3, rate: 1000, discount_pct: 10, tax_rate: 18 }, 'intra');
    expect(r).toMatchObject({ gross: 3000, discount: 300, taxable: 2700, cgst: 243, sgst: 243, igst: 0, tax: 486 });
  });
  it('charges IGST on inter-state supplies', () => {
    const r = computeTaxLine({ qty: 1, rate: 1000, tax_rate: 5 }, 'inter');
    expect(r).toMatchObject({ taxable: 1000, igst: 50, cgst: 0, sgst: 0 });
  });
  it('backs tax out of tax-inclusive prices', () => {
    const r = computeTaxLine({ qty: 1, rate: 1180, tax_rate: 18 }, 'intra', true);
    expect(r.taxable).toBe(1000);
    expect(r.cgst + r.sgst).toBe(180);
  });
  it('zero-rates exports under LUT and exempt items', () => {
    expect(computeTaxLine({ qty: 1, rate: 500, tax_rate: 18 }, 'zero_rated').tax).toBe(0);
    expect(computeTaxLine({ qty: 1, rate: 500, tax_rate: 18, tax_exempt: 'nil' }, 'intra').tax).toBe(0);
  });
  it('determines the supply type from place of supply and GST treatment', () => {
    expect(supplyKind({ ourState: '29', placeOfSupply: '29', gstTreatment: 'business_gst', side: 'sales' })).toBe('intra');
    expect(supplyKind({ ourState: '29', placeOfSupply: '27', gstTreatment: 'business_gst', side: 'sales' })).toBe('inter');
    expect(supplyKind({ ourState: '29', placeOfSupply: '96', gstTreatment: 'overseas', side: 'sales' })).toBe('zero_rated');
    expect(supplyKind({ ourState: '29', placeOfSupply: '96', gstTreatment: 'overseas', side: 'sales', withPayment: true })).toBe('inter');
    expect(supplyKind({ ourState: '29', placeOfSupply: '29', gstTreatment: 'business_none', side: 'purchase' })).toBe('none');
    expect(supplyKind({ ourState: '29', placeOfSupply: '29', gstTreatment: 'business_none', side: 'purchase', reverseCharge: true })).toBe('intra');
  });
  it('computes TDS on the value excluding GST', () => {
    expect(computeTds(85000, 10)).toBe(8500);
  });
});

describe('GST set-off (Rule 88A)', () => {
  it('uses IGST credit first, then CGST/SGST credits without crossing them', () => {
    const r = gstSetOff({ igst: 1000, cgst: 500, sgst: 500 }, { igst: 1200, cgst: 100, sgst: 600 });
    expect(r.used.igst.igst).toBe(1000);
    // remaining IGST 200 goes to the CGST shortfall
    expect(r.used.igst.cgst).toBe(200);
    expect(r.used.cgst.cgst).toBe(100);
    expect(r.used.sgst.sgst).toBe(500);
    expect(r.cash).toEqual({ igst: 0, cgst: 200, sgst: 0 });
    expect(r.carry_forward.sgst).toBe(100);
  });
  it('pays cash when credit is insufficient', () => {
    const r = gstSetOff({ igst: 0, cgst: 900, sgst: 900 }, { igst: 0, cgst: 1000, sgst: 100 });
    expect(r.cash).toEqual({ igst: 0, cgst: 0, sgst: 800 });
    expect(r.carry_forward.cgst).toBe(100); // CGST credit can never pay SGST
  });
  it('uses CGST/SGST credit against IGST liability after their own heads', () => {
    const r = gstSetOff({ igst: 500, cgst: 0, sgst: 0 }, { igst: 0, cgst: 300, sgst: 300 });
    expect(r.cash.igst).toBe(0);
    expect(r.used.cgst.igst + r.used.sgst.igst).toBe(500);
  });
});

describe('Identifiers and helpers', () => {
  it('validates GSTIN check digits', () => {
    expect(validateGstin('27AAPFU0939F1ZV')).toBeNull();
    expect(validateGstin('27AAPFU0939F1ZA')).toMatch(/check digit/);
    expect(validateGstin('99AAPFU0939F1ZV')).toMatch(/state/);
    const g = makeGstin('29', 'AAKCK4821F');
    expect(validateGstin(g)).toBeNull();
  });
  it('computes Indian fiscal years', () => {
    expect(fiscalYear('2026-10-23')).toMatchObject({ start: '2026-04-01', end: '2027-03-31', label: '2026-27' });
    expect(fiscalYear('2027-02-01')).toMatchObject({ start: '2026-04-01', label: '2026-27' });
  });
  it('writes amounts in Indian numbering', () => {
    expect(amountInWords(1234567.5)).toBe('Indian Rupee Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Fifty Paise Only');
  });
  it('computes e-way bill validity at 200 km per day', () => {
    expect(ewayValidity('2026-10-01T10:00:00Z', 150).days).toBe(1);
    expect(ewayValidity('2026-10-01T10:00:00Z', 201).days).toBe(2);
    expect(ewayValidity('2026-10-01T10:00:00Z', 840)).toMatchObject({ days: 5, valid_until: '2026-10-06T23:59:59' });
    expect(ewayValidity('2026-10-01T10:00:00Z', 30, true).days).toBe(2);
  });
});
