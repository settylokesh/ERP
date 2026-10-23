# 09 · GST, e-invoicing and e-way bills

Code: `server/src/tax.ts`, `server/src/gst.ts`, `server/src/einvoice.ts`, `server/src/util.ts` (states, GSTIN).

## Supply kind

`supplyKind()` decides how GST applies to a priced document:

| Situation | Kind | Effect |
|---|---|---|
| Sale to overseas customer, or to SEZ, without payment of tax (LUT) | `zero_rated` | no tax; lines marked zero-rated |
| Same with `data.export_with_payment = true` | `inter` | IGST |
| Purchase from overseas vendor without reverse charge | `none` | no GST on the bill (IGST is paid at customs) |
| Purchase from unregistered, composition or consumer supplier without reverse charge | `none` | no GST |
| Place of supply = our state (warehouse state, else organisation state) | `intra` | CGST + SGST, each half the rate |
| Otherwise | `inter` | IGST |

`computeTaxLine()` per line: gross = qty × rate; discount = gross × discount %; taxable = net (or net × 100 ÷ (100 +
rate) for tax-inclusive prices); CGST = SGST = taxable × rate ÷ 200, or IGST = taxable × rate ÷ 100. Exempt, nil,
non-GST and zero-rated lines carry no tax. Every step is rounded to paise.

GSTIN validation (`validateGstin`): format `99AAAAA9999A9Z9`, a valid state code, and the mod-36 check digit.

## GSTR-1 (`gstr1(period)`)

Built from invoices and credit notes in posted statuses dated in the month (`YYYY-MM`).

| Section | Rule |
|---|---|
| B2B (4A, 4B, 6B, 6C) | Registered / SEZ / deemed-export customers with a GSTIN; invoice type R, SEWP/SEWOP, DE; IRN included when recorded |
| B2CL (5) | Inter-state, unregistered, invoice value above the B2CL threshold (default ₹1,00,000) |
| B2CS (7) | Other B2C, grouped by place of supply and rate |
| Exports (6A) | Overseas customers; WPAY (IGST paid) or WOPAY (LUT) |
| CDNR (9B) | Credit notes to registered customers |
| CDNUR (9B) | Credit notes for exports or large inter-state B2C |
| HSN (12) | Split into B2B and B2C tables; UQC from the unit (services report `NA`) |
| Nil/exempt/non-GST (8) | By inter/intra and registered/unregistered |
| Documents issued (13) | Invoice and credit-note number ranges, totals and cancelled (void) counts |

`GET /api/gst/gstr1/json?period=` downloads the same data in the GST portal's offline-tool JSON layout
(`gstin`, `fp` = MMYYYY, `b2b`, `b2cl`, `b2cs`, `exp`, `cdnr`, `cdnur`, `hsn`, `nil`, `doc_issue`). Amounts are INR.

## GSTR-3B (`gstr3b(period)`)

| Table | Content |
|---|---|
| 3.1(a) | Taxable outward supplies (not zero-rated/nil/exempt) |
| 3.1(b) | Zero-rated (exports, SEZ) |
| 3.1(c) | Nil-rated and exempt outward |
| 3.1(d) | Inward supplies liable to reverse charge |
| 3.1(e) | Non-GST outward |
| 3.2 | Inter-state supplies to unregistered persons by place of supply |
| 4(A)(3), 4(A)(5), 4(C), 4(D) | ITC on reverse charge, all other ITC, net ITC, ineligible ITC |
| 5 | Exempt/nil/composition and non-GST inward supplies |
| 6.1 | Set-off of forward-charge liability against ITC; reverse-charge tax in cash |

**Set-off (`gstSetOff`)** follows Section 49 and Rule 88A of the CGST Act/Rules: IGST credit first against IGST, then
against CGST and SGST (the head with the larger shortfall first, to minimise cash); CGST credit against CGST then IGST;
SGST credit against SGST then IGST; CGST and SGST credits are never crossed. Credit notes and vendor credits reduce
the respective figures. The due date shown is the 20th of the following month (monthly filers).

## GSTR-2B reconciliation

`POST /api/gst/gstr2b/reconcile { period, entries[] }` where entries come from the GSTR-2B JSON downloaded from the
portal (the UI parses `data.docdata.b2b`) or a CSV (`ctin,inum,idt,txval,iamt,camt,samt`). Entries are matched to bills
by supplier GSTIN and normalised invoice number (`data.vendor_invoice_no`, else `reference`, else bill number). Results:
matched, mismatch (taxable or tax differs by more than ₹1), missing in books, missing in 2B.

## e-Invoicing

The application **does not call the IRP**. It prepares the request, a person generates the IRN on the e-invoice portal
(or through their GST Suvidha Provider), and the IRN details are recorded back. No IRN is ever invented.

Applicable to invoices and credit notes in issued statuses for registered (B2B), SEZ, deemed-export and overseas
customers. B2C invoices are refused.

### Export (`GET /api/docs/:type/:id/einvoice.json`; bulk `POST /api/gst/einvoice-export`)

The payload follows e-invoice schema version 1.1 (INV-01). Field names were cross-checked against the GST library
`resilient-tech/india-compliance` (GitHub) because the NIC portal could not be fetched from the build environment.

| Section | Fields and mapping |
|---|---|
| `Version` | `"1.1"` |
| `TranDtls` | `TaxSch: "GST"`, `SupTyp`: B2B, SEZWP/SEZWOP, EXPWP/EXPWOP, DEXP; `RegRev: "N"`; `IgstOnIntra: "N"` |
| `DocDtls` | `Typ`: INV or CRN; `No`: document number; `Dt`: dd/mm/yyyy |
| `SellerDtls` | `Gstin`, `LglNm` (legal name), `TrdNm`, `Addr1`/`Addr2` (address split at ~95 characters), `Loc` (city), `Pin`, `Stcd` (state code), `Ph`, `Em` |
| `BuyerDtls` | `Gstin` (`URP` for exports), `LglNm`, `TrdNm`, `Pos` (place of supply; `96` for exports), `Addr1`/`Addr2`, `Loc`, `Pin` (999999 for exports), `Stcd` |
| `ItemList[]` | `SlNo`, `PrdDesc`, `IsServc` (Y for services/SAC 99…), `HsnCd`, `Qty`, `Unit` (UQC, goods only), `UnitPrice`, `TotAmt` (gross), `Discount`, `AssAmt` (taxable), `GstRt`, `IgstAmt`, `CgstAmt`, `SgstAmt`, cess fields 0, `TotItemVal` |
| `ValDtls` | `AssVal`, `CgstVal`, `SgstVal`, `IgstVal`, `CesVal`, `StCesVal`, `Discount`, `OthChrg`, `RndOffAmt`, `TotInvVal`, `TotInvValFc` (foreign currency) |
| `ExpDtls` | `CntCode` (customer country), `ForCur` (non-INR) — exports only |
| `RefDtls.PrecDocDtls` | Original invoice number and date — credit notes created from an invoice (directly or via a sales return) |

All values are INR (document amounts × exchange rate). Before exporting, the server checks and lists every problem at
once: organisation GSTIN/address/city/PIN, customer GSTIN/address/city/PIN or country, document number (GST rule 46:
at most 16 characters of letters, digits, `-` and `/`), HSN codes of 4, 6 or 8 digits. The bulk export with `?check=1`
returns `{ ready[], problems[] }` so incomplete documents can be fixed without blocking the rest; without `check` it
downloads a JSON array of the ready payloads.

Units are mapped to GST Unit Quantity Codes by `uqc()` (pcs→PCS, nos→NOS, kg→KGS, l→LTR, m→MTR, box→BOX, set→SET, …;
anything else → OTH).

### Record and cancel

- `einvoice_record { irn (64 hex), ack_no (10–20 digits), ack_date, signed_qr? }` — requires e-invoicing to be turned
  on for the organisation; refuses an IRN already recorded on another document. The signed QR code (the
  `SignedQRCode` returned by the IRP) is printed as a QR image on the invoice. While an IRN is recorded the document
  cannot be edited, voided or deleted.
- `einvoice_cancel { reason_code, remarks }` — after cancelling on the IRP, within 24 hours of the acknowledgement.
  Reason codes: 1 Duplicate, 2 Data entry mistake, 3 Order cancelled, 4 Others.

## e-Way bills

### Export (`POST /api/docs/:type/:id/ewaybill.json` with transport details)

Produces the e-way bill portal's bulk-generation file `{ "version": "1.0.0621", "billLists": [ … ] }`. One entry:

| Field | Mapping |
|---|---|
| `userGstin`, `supplyType` | Organisation GSTIN; `O` outward (invoice, challan), `I` inward (credit note = sales return) |
| `subSupplyType`, `subSupplyDesc` | 1 Supply; 3 Export; 7 Sales Return; challans by type: 4 Job Work, 5 For Own Use / Branch Transfer, 8 Others (Supply on Approval), 9 SKD/CKD, 10 Line Sales, 11 Recipient Not Known, 12 Exhibition or Fairs |
| `docType`, `docNo`, `docDate` | INV, CHL or BIL (bill of supply: exports without tax or all-exempt invoices); number; dd/mm/yyyy |
| `transType` | 1 (regular) |
| `from*` / `to*` | GSTIN (`URP` for unregistered), trade name, `Addr1/2`, place, PIN, `fromStateCode`/`toStateCode` (billing), `actualFromStateCode`/`actualToStateCode` (dispatch/ship). Dispatch uses the warehouse address and PIN when set, else the organisation's; ship-to uses the customer's shipping address when given |
| Values | `totalValue` (taxable), `cgstValue`, `sgstValue`, `igstValue`, `cessValue`, `TotNonAdvolVal`, `OthValue`, `totInvValue` — goods lines only, INR |
| Transport | `transMode` (1 Road, 2 Rail, 3 Air, 4 Ship), `transDistance` (km), `transporterId`, `transporterName`, `transDocNo`, `transDocDate`, `vehicleNo`, `vehicleType` (R regular, O over-dimensional) |
| `itemList[]` | `itemNo`, `productName`, `productDesc`, `hsnCode`, `quantity`, `qtyUnit`, `taxableAmount`, `sgstRate`, `cgstRate`, `igstRate`, `cessRate`, `cessNonAdvol` |
| `mainHsnCode` | HSN of the highest-value goods line |

Transport validation: distance 1–4000 km; road needs a vehicle number (e.g. `KA01AB1234`) or a 15-character
transporter ID; rail/air/ship need a transport document number.

### Record, update, cancel

- `eway_record { ewb_no (12 digits), ewb_date, distance, transport_mode, vehicle_no, vehicle_type, transporter_* }`.
  Validity per Rule 138(10): 1 day per 200 km (20 km for over-dimensional cargo), ending at midnight; it starts only when
  Part-B (vehicle) is present for road transport. An explicit `valid_until` from the portal overrides the calculation.
- `eway_update_vehicle { vehicle_no, reason_code }` — reason codes 1 Break down, 2 Transhipment, 3 Others, 4 First time;
  history kept.
- `eway_cancel { reason_code }` within 24 hours — 1 Duplicate, 2 Order cancelled, 3 Data entry mistake, 4 Others.

The e-way bill threshold (default ₹50,000) is a setting shown to users; the portal enforces the rules.
