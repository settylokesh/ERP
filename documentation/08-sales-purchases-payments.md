# 08 · Sales, purchases and payments

## Contacts (`masters.ts`)

Customers and vendors share the `contacts` table (`kind`).

| Field | Rule |
|---|---|
| Display name | Required; unique per kind (case-insensitive) |
| GST treatment | `business_gst`, `business_composition`, `business_none`, `consumer`, `overseas`, `sez`, `deemed_export` |
| GSTIN | Required and check-digit validated for registered treatments; cleared for unregistered; PAN derived from it |
| Place of supply | From GSTIN state, else given, else the organisation's state; overseas = `96` |
| Addresses | Street, city, PIN (6 digits, except overseas), state; `billing_country` (ISO-2) for exports |
| Currency | Must exist in Currencies |
| Opening balance | Posted on the opening balance date against Opening Balance Adjustments |
| Delete | Only without documents or payments; otherwise deactivate |

`GET /api/contacts/:id/statement?from&to` returns opening balance, every AR/AP posting in the period with a running
balance, and the closing balance.

CSV import (`POST /api/contacts/import?kind=customer`, body `text/csv`): header row with any contact field names
(`name, company_name, email, phone, gst_treatment, gstin, payment_terms, billing_address, billing_city, billing_pincode…`);
returns `{ imported, errors[] }` with a message per failed row.

## Sales flow

- **Quote** → mark accepted/declined → convert to sales order or invoice. Expired is a display status (past expiry).
- **Sales order** (`confirmed`) commits stock. Create packages (ship → physical stock out), delivery challans, invoices,
  purchase orders (for drop-ship/back-to-back) or manufacturing orders from it.
- **Package**: packed → shipped (date, carrier, tracking, charges) → delivered. Undo shipment returns it to packed.
- **Delivery challan**: goods movement without a sale (job work, supply on approval, branch transfer, exhibitions…);
  `data.challan_type` maps to the e-way bill sub-supply type. Mark delivered, returned, or invoice it.
- **Invoice**: due date from payment terms; tax invoice print with amount in words; e-invoice and e-way bill files
  ([09](09-gst-and-e-invoicing.md)). Status follows payments: open → partially paid → paid; overdue is a display status.
- **Sales return (RMA)**: from an order (limited to shipped quantity) or an invoice; `receive_return` brings goods back
  (physical). A **credit note** from the return books the accounting side; the return becomes `credited`.
- **Credit note**: reduces what the customer owes. Apply to open invoices, or refund. Lines can skip restocking
  (`return_to_stock = false`), e.g. damaged goods written off.
- **Retainer invoice**: an advance request. Payments against it create a credit that can be applied to later invoices
  (`credit_available` = paid − already applied).
- **Recurring invoices**: profile with frequency (weekly/monthly/quarterly/yearly × every N), start/end date and an
  invoice template; due invoices are generated hourly or on demand; optional automatic email. A failing profile is
  set to `stopped` and reported to administrators once; it does not stop the others. After fixing the cause, set it
  back to Active and the missed invoices are generated on the next run.

## Purchase flow

- **Purchase request** (internal, approvable) → RFQ or purchase order.
- **RFQ**: invite vendors (`data.vendor_ids`) → `publish` (emails invited vendors with an address) → `record_bid`
  per vendor and line (staff-entered "surrogate" bids; late bids need `allow_late`) → `close_bidding` → `award`
  (explicit `awards[]` or `lowest: true`) → `create_pos` (one draft PO per awarded vendor at the awarded rates).
- **Purchase order** (`issued`) → receives and bills; auto-closes when fully received and billed.
- **Purchase receive (GRN)**: physical stock in. If any item has an active quality rule for receives, the receive is
  `pending_inspection` and holds no stock until inspections are recorded; the accepted quantity (`qty2`) is what enters
  stock and what the PO counts as received.
- **Bill**: vendor's bill number goes in `reference` (unique per vendor, case-insensitive, among non-void bills; also
  used to match GSTR-2B). A bill created from a PO or receive starts with an empty reference so several partial bills
  can be raised against one order; the source is kept in `ref_doc_id`. Options:
  - **ITC eligibility** per line (`itc_eligible = false` adds the tax to cost instead of Input tax);
  - **Reverse charge** (`reverse_charge`): tax is computed and posted to Input tax and RCM payable but not added to the
    total payable to the vendor;
  - **TDS** (`data.tds_section_id`): deducted on the taxable value and credited to TDS payable;
  - **Landed cost**: account lines flagged `landed_cost` are spread across stock lines by value or quantity;
  - supplies from unregistered or composition vendors carry no GST unless reverse charge applies.
- **Vendor credit (debit note)**: return goods (stock out at carrying cost) or correct the price
  ([07](07-inventory-valuation.md#price-corrections-from-vendors)); apply to bills or refund.
- **Expense**: direct spend paid from a bank, cash or card account (`data.paid_through_account_id`), with GST/ITC.

## Payments (`payments.ts`)

`POST /api/payments/received` or `/made`:

| Field | Rule |
|---|---|
| `contact_id` | Customer for received, vendor for made |
| `amount` | > 0 |
| `bank_charges` | ≥ 0; for received must be less than the amount (bank deposits amount − charges) |
| `tds_amount` | TDS deducted by the customer (received); credited to TDS Receivable |
| `account_id` | Cash, bank, card or other current asset account |
| `mode` | cash, bank_transfer, cheque, upi, card, neft, rtgs, imps, other |
| `currency_code`, `exchange_rate` | Defaults to the first allocated document's currency |
| `allocations[]` | `{ document_id, amount }`; each document must belong to the contact, be open, be invoice/retainer (received) or bill (made), be in the payment currency, and not be over-allocated; total ≤ amount + TDS. Allocations already on a payment saved by an older version stay editable while the payment keeps its currency |

Anything not allocated is **unused** credit (`paymentUnused`) that can later be applied to documents
(`POST /api/credits/apply` with `payment_id`) or refunded. Editing or deleting a payment is refused when it is part of a
completed bank reconciliation or in a locked period; deleting also deletes its refunds and releases bank matches.

## Applying credits and refunds

- `applyCredits({ credit_doc_id | payment_id }, allocations, date)` — credit notes, vendor credits, retainer advances or
  unused payments against open invoices/bills of the same contact; cannot exceed the credit available or each
  document's balance. Removing an application (`DELETE /api/credits/:id`) restores both balances.
- `createRefund({ credit_doc_id | payment_id, amount, account_id, date })` — pays money back from an open credit or an
  unused payment; posts AR/AP against the bank.

## Balances and statuses

`refreshBalance(doc)`:

- invoices, bills, retainers: `balance = total − (payments allocated + credits applied)`; status open / partially paid /
  paid (retainers: open / paid);
- credit notes and vendor credits: `balance = total − (applied + refunded)`; status open / closed.

A document's total cannot be reduced below what has already been paid or credited.
