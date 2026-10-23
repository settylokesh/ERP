import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { date, money, qty } from '../../lib/format';
import { useMeta } from '../../lib/hooks';

const TITLES: Record<string, string> = {
  invoice: 'TAX INVOICE', quote: 'QUOTATION', sales_order: 'SALES ORDER', credit_note: 'CREDIT NOTE', delivery_challan: 'DELIVERY CHALLAN',
  retainer_invoice: 'RETAINER INVOICE', purchase_order: 'PURCHASE ORDER', bill: 'BILL', vendor_credit: 'DEBIT NOTE', package: 'PACKING SLIP',
  purchase_receive: 'GOODS RECEIPT NOTE', transfer_order: 'TRANSFER ORDER', sales_return: 'SALES RETURN', purchase_request: 'PURCHASE REQUEST',
  rfq: 'REQUEST FOR QUOTATION', expense: 'EXPENSE VOUCHER', inventory_adjustment: 'INVENTORY ADJUSTMENT', stock_count: 'STOCK COUNT SHEET',
};

function words(n: number) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x: number) => (x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]}${x % 10 ? ' ' + ones[x % 10] : ''}`);
  const three = (x: number) => [Math.floor(x / 100) ? `${ones[Math.floor(x / 100)]} Hundred` : '', x % 100 ? two(x % 100) : ''].filter(Boolean).join(' ');
  const w = (x: number): string => {
    if (!x) return 'Zero';
    const p: string[] = [];
    const cr = Math.floor(x / 1e7); x %= 1e7;
    const lk = Math.floor(x / 1e5); x %= 1e5;
    const th = Math.floor(x / 1e3); x %= 1e3;
    if (cr) p.push(`${w(cr)} Crore`);
    if (lk) p.push(`${two(lk)} Lakh`);
    if (th) p.push(`${two(th)} Thousand`);
    if (x) p.push(three(x));
    return p.join(' ');
  };
  const abs = Math.abs(Math.round(n * 100) / 100);
  const r = Math.floor(abs), paise = Math.round((abs - r) * 100);
  return `Indian Rupee ${w(r)}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
}

export default function PrintDoc({ doc }: { doc: any }) {
  const { meta } = useMeta();
  const o = doc.org ?? meta.org;
  const [qr, setQr] = useState<string | null>(null);
  const e = doc.data?.einvoice;
  useEffect(() => {
    if (e?.status === 'generated' && e.signed_qr) QRCode.toDataURL(e.signed_qr, { margin: 1, width: 140 }).then(setQr).catch(() => setQr(null));
    else setQr(null);
  }, [e?.status, e?.signed_qr]);
  const def = meta.doc_types[doc.type];
  const c = doc.contact;
  const sym = doc.currency_code && doc.currency_code !== 'INR' ? `${doc.currency_code} ` : '₹';
  const showTax = def.priced;
  const intra = doc.cgst_total > 0 || (doc.igst_total === 0 && doc.place_of_supply === o.state_code);
  const ewb = doc.data?.ewaybill;
  return (
    <div className="print-area card mx-auto max-w-4xl bg-white p-8 text-[12px] leading-relaxed text-slate-800">
      <div className="flex items-start justify-between gap-6 border-b pb-4">
        <div>
          <div className="text-lg font-bold text-slate-900">{o.legal_name || o.name}</div>
          <div className="whitespace-pre-line text-slate-600">{[o.address, [o.city, o.pincode].filter(Boolean).join(' - '), meta.states[o.state_code]].filter(Boolean).join('\n')}</div>
          {o.gstin && <div className="mt-1">GSTIN: <b>{o.gstin}</b></div>}
          {o.phone && <div>{o.phone} {o.email && `· ${o.email}`}</div>}
        </div>
        <div className="text-right">
          <div className="text-xl font-bold tracking-wide text-slate-900">{TITLES[doc.type] ?? def.label.toUpperCase()}</div>
          <div className="mt-1"># <b>{doc.number}</b></div>
          {doc.status === 'void' && <div className="mt-1 font-bold text-red-600">VOID</div>}
          {qr && <img src={qr} alt="e-Invoice QR code" className="ml-auto mt-2 h-28 w-28" />}
        </div>
      </div>
      {e?.status === 'generated' && (
        <div className="mt-2 break-all rounded bg-slate-50 p-2 text-[11px]"><b>IRN:</b> {e.irn} · <b>Ack No:</b> {e.ack_no} · <b>Ack Date:</b> {date(e.ack_date)}{e.sandbox && ' · (sandbox)'}</div>
      )}
      <div className="grid gap-6 py-4 sm:grid-cols-2">
        <div>
          {c && (
            <>
              <div className="text-[11px] font-semibold uppercase text-slate-500">{def.party === 'vendor' ? 'Vendor' : 'Bill To'}</div>
              <div className="font-semibold">{c.company_name || c.name}</div>
              <div className="whitespace-pre-line text-slate-600">{c.billing_address}</div>
              {c.gstin && <div>GSTIN: {c.gstin}</div>}
              {c.shipping_address && def.party === 'customer' && <><div className="mt-2 text-[11px] font-semibold uppercase text-slate-500">Ship To</div><div className="whitespace-pre-line text-slate-600">{c.shipping_address}</div></>}
            </>
          )}
          {doc.type === 'transfer_order' && <div>From <b>{doc.warehouse_name}</b> to <b>{doc.to_warehouse_name}</b></div>}
        </div>
        <div className="space-y-0.5 sm:text-right">
          <div>Date: <b>{date(doc.date)}</b></div>
          {doc.due_date && <div>{doc.type === 'quote' ? 'Expiry' : 'Due'} Date: <b>{date(doc.due_date)}</b></div>}
          {doc.payment_terms ? <div>Terms: Net {doc.payment_terms}</div> : null}
          {doc.reference && <div>Reference: {doc.reference}</div>}
          {doc.place_of_supply && showTax && <div>Place of Supply: {meta.states[doc.place_of_supply]} ({doc.place_of_supply})</div>}
          {doc.reverse_charge ? <div className="font-semibold">Tax payable on reverse charge: Yes</div> : null}
          {doc.data?.challan_type && <div>Challan type: {doc.data.challan_type}</div>}
          {ewb?.status === 'generated' && <div>e-Way Bill: <b>{ewb.ewb_no}</b> (valid till {date(ewb.valid_until)})</div>}
        </div>
      </div>
      <table className="w-full border-collapse text-[11.5px]">
        <thead>
          <tr className="bg-slate-800 text-white">
            <th className="px-2 py-1.5 text-left">#</th><th className="px-2 py-1.5 text-left">Item & Description</th>
            {showTax && <th className="px-2 py-1.5 text-left">HSN/SAC</th>}
            <th className="px-2 py-1.5 text-right">Qty</th>
            {(showTax || doc.type === 'purchase_request') && <th className="px-2 py-1.5 text-right">Rate</th>}
            {showTax && <th className="px-2 py-1.5 text-right">Taxable</th>}
            {showTax && (intra ? <><th className="px-2 py-1.5 text-right">CGST</th><th className="px-2 py-1.5 text-right">SGST</th></> : <th className="px-2 py-1.5 text-right">IGST</th>)}
            {showTax && <th className="px-2 py-1.5 text-right">Amount</th>}
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l: any, i: number) => (
            <tr key={l.id} className="border-b border-slate-200">
              <td className="px-2 py-1.5 align-top">{i + 1}</td>
              <td className="px-2 py-1.5 align-top"><div className="font-medium">{l.item_name ?? l.description}</div>{l.item_name && l.description && l.description !== l.item_name && <div className="text-slate-500">{l.description}</div>}
                {l.tracking?.length > 0 && <div className="text-[10.5px] text-slate-500">{l.tracking.map((t: any) => t.serial_no ?? `${t.batch_no} × ${t.qty}`).join(', ')}</div>}
                {l.discount_pct > 0 && <div className="text-[10.5px] text-slate-500">Discount {l.discount_pct}%</div>}</td>
              {showTax && <td className="px-2 py-1.5 align-top">{l.hsn_code}</td>}
              <td className="px-2 py-1.5 text-right align-top">{qty(doc.type === 'stock_count' ? l.qty2 ?? l.qty : l.qty)} {l.unit}</td>
              {(showTax || doc.type === 'purchase_request') && <td className="px-2 py-1.5 text-right align-top">{money(l.rate, sym)}</td>}
              {showTax && <td className="px-2 py-1.5 text-right align-top">{money(l.taxable, sym)}</td>}
              {showTax && (intra
                ? <><td className="px-2 py-1.5 text-right align-top">{money(l.cgst, sym)}<div className="text-[10px] text-slate-500">{l.tax_rate / 2}%</div></td><td className="px-2 py-1.5 text-right align-top">{money(l.sgst, sym)}<div className="text-[10px] text-slate-500">{l.tax_rate / 2}%</div></td></>
                : <td className="px-2 py-1.5 text-right align-top">{money(l.igst, sym)}<div className="text-[10px] text-slate-500">{l.tax_rate}%</div></td>)}
              {showTax && <td className="px-2 py-1.5 text-right align-top">{money(l.taxable + l.cgst + l.sgst + l.igst, sym)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {showTax && (
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:justify-between">
          <div className="max-w-sm text-slate-600">
            <div className="text-[11px] font-semibold uppercase text-slate-500">Total in words</div>
            <div className="italic">{doc.currency_code === 'INR' ? words(doc.total) : `${doc.currency_code} ${doc.total} (≈ ${money(doc.total * doc.exchange_rate)} at ${doc.exchange_rate})`}</div>
          </div>
          <div className="w-full max-w-xs space-y-1">
            <div className="flex justify-between"><span>Sub Total</span><span>{money(doc.taxable_total, sym)}</span></div>
            {doc.cgst_total > 0 && <div className="flex justify-between"><span>CGST</span><span>{money(doc.cgst_total, sym)}</span></div>}
            {doc.sgst_total > 0 && <div className="flex justify-between"><span>SGST</span><span>{money(doc.sgst_total, sym)}</span></div>}
            {doc.igst_total > 0 && <div className="flex justify-between"><span>IGST</span><span>{money(doc.igst_total, sym)}</span></div>}
            {doc.reverse_charge ? <div className="text-[11px] text-slate-500">GST under reverse charge not included</div> : null}
            {doc.adjustment ? <div className="flex justify-between"><span>Adjustment</span><span>{money(doc.adjustment, sym)}</span></div> : null}
            {doc.tds_amount ? <div className="flex justify-between"><span>TDS ({doc.data?.tds_section})</span><span>-{money(doc.tds_amount, sym)}</span></div> : null}
            <div className="flex justify-between border-t pt-1 text-sm font-bold"><span>Total</span><span>{money(doc.total, sym)}</span></div>
            {['invoice', 'bill', 'retainer_invoice'].includes(doc.type) && doc.total !== doc.balance && <div className="flex justify-between font-semibold text-slate-700"><span>Balance Due</span><span>{money(doc.balance, sym)}</span></div>}
          </div>
        </div>
      )}
      {(doc.notes || doc.terms) && (
        <div className="mt-6 space-y-3 border-t pt-3 text-slate-600">
          {doc.notes && <div><div className="text-[11px] font-semibold uppercase text-slate-500">Notes</div><div className="whitespace-pre-line">{doc.notes}</div></div>}
          {doc.terms && <div><div className="text-[11px] font-semibold uppercase text-slate-500">Terms & Conditions</div><div className="whitespace-pre-line">{doc.terms}</div></div>}
        </div>
      )}
      <div className="mt-10 flex justify-end"><div className="text-center"><div className="h-10" /><div className="border-t border-slate-400 px-8 pt-1 text-[11px]">Authorised Signatory · {o.name}</div></div></div>
    </div>
  );
}
