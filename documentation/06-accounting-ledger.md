# 06 · Accounting ledger

`server/src/ledger.ts` owns the chart of accounts and the journal. Every module that affects money posts through it.

## Account types

| Type | Category | Debit-natured? |
|---|---|---|
| cash, bank, accounts_receivable, other_current_asset, stock, fixed_asset, other_asset | asset | yes |
| credit_card, accounts_payable, other_current_liability, long_term_liability, other_liability | liability | no |
| equity | equity | no |
| income, other_income | income | no |
| expense, cost_of_goods_sold, other_expense | expense | yes |

`accountBalance(id, to?, from?)` returns the natural-sign balance (positive when the account has its normal balance),
counting only `posted` journals.

Rules on accounts (`masters.ts → saveAccount`): codes are unique; a system account's type cannot change; the category
cannot change once the account has transactions; a parent must be of the same category; bank IFSC is validated; an
account with transactions cannot be deleted (deactivate it instead).

## Default chart of accounts and system keys

`DEFAULT_ACCOUNTS` seeds an Indian chart of accounts. Accounts the code posts to carry a stable `system_key`; resolve
them with `acct('key')` (cached per database). Renaming or renumbering a system account is safe; deleting it is not
possible once used.

| Key | Account | Used by |
|---|---|---|
| `petty_cash`, `undeposited_funds` | Petty Cash, Undeposited Funds | default cash accounts |
| `accounts_receivable` / `accounts_payable` | AR / AP | invoices, bills, payments, credits, refunds |
| `tds_receivable` | TDS Receivable | TDS deducted by customers on payments received |
| `inventory_asset` | Inventory Asset | default inventory account for stock items |
| `input_cgst/sgst/igst` | Input tax | eligible GST on bills and expenses |
| `output_cgst/sgst/igst` | Output tax | GST on invoices and credit notes |
| `rcm_payable` | Reverse Charge Tax Payable | bills under reverse charge |
| `tds_payable`, `tds_salary_payable` | TDS payable | bills with TDS; payroll |
| `epf_payable`, `esi_payable`, `pt_payable`, `salary_payable` | Payroll liabilities | pay runs |
| `opening_balance_adjustments` | Opening balance offset | opening stock and contact opening balances |
| `unearned_revenue` | Advances | (available for retainer accounting) |
| `share_capital`, `retained_earnings`, `drawings` | Equity | banking owner transactions, closing |
| `sales`, `service_income`, `shipping_charge` | Income | default income accounts |
| `other_income`, `interest_income`, `asset_disposal` | Other income | banking, asset disposal gains |
| `cogs`, `inventory_adjustment`, `mfg_absorption`, `freight_inward`, `purchases` | Cost of goods sold group | COGS, adjustments, absorbed labour/overhead, freight, non-stock purchases |
| `salaries`, `employer_pf`, `employer_esi` | Payroll expense | pay runs |
| `rent`, `office_supplies`, `utilities`, `travel`, `telephone`, `advertising`, `repairs`, `professional_fees`, `bank_charges`, `depreciation`, `bad_debts`, `uncategorized` | Expenses | various |
| `rounding`, `exchange_gain_loss`, `interest_expense` | Other expenses | rounding adjustments, realised FX |
| `furniture`, `machinery`, `computers`, `accumulated_depreciation` | Fixed assets | asset types |

## Journals

A journal belongs to exactly one **source** (`source_type`, `source_id`): a document (`invoice`, `bill`, …), `payment`,
`refund`, `bank_txn`, `manual_journal`, `mo`, `pay_run`, `pay_run_payment`, `payslip_release`, `asset_acquisition`,
`asset_depreciation`, `asset_disposal`, `item_opening`, `contact_opening`.

- `postJournal(spec)` normalises lines (negative amounts flip sides, zero lines dropped) and refuses unbalanced
  journals (`422 Journal is not balanced`).
- `replaceJournal(sourceType, sourceId, spec | null)` is the only way sources update their accounting: it deletes the
  source's journals and posts the new one. It keeps bank-reconciliation marks on the same account and calls
  `syncBankMatches` so a matched bank-statement line is released if the new posting no longer has the same amount on
  that bank account.
- `assertNotReconciled(sourceType, id, action)` blocks editing or deleting anything that has a reconciled bank line.

## Posting rules

Amounts below are in INR (document amounts × exchange rate). "Stock value" comes from the item's valuation replay
([07](07-inventory-valuation.md)).

| Source | Debit | Credit |
|---|---|---|
| Invoice | AR (total) ; COGS (stock value of goods out) | Sales/item income account (taxable per line); Output CGST/SGST/IGST; Rounding (adjustment); Inventory (stock value) |
| Credit note | Sales/income; Output tax; Inventory (returned stock value) | AR; COGS |
| Bill | Inventory (stock lines: taxable + landed cost + ineligible tax) or purchase/expense account (other lines); Input tax (eligible ITC) | AP (balancing); RCM payable (reverse charge tax); TDS payable |
| Vendor credit | AP | Inventory (returns at carrying cost; price corrections: share still in stock); COGS (difference, and price corrections on stock already consumed or not linked to a bill line); purchase account (non-stock lines); Input tax |
| Expense | Expense accounts; Input tax | Paid-through account (bank/cash/card) |
| Inventory adjustment | Inventory / adjustment account (by sign) | adjustment account (default "Inventory Adjustments") / Inventory |
| Transfer order | — (valuation neutral) | — |
| Package, receive, delivery challan, sales return | — (physical only) | — |
| Payment received | Bank (amount − charges); Bank charges; TDS receivable | AR (allocated at invoice rates + unallocated at payment rate); FX gain/loss |
| Payment made | AP; Bank charges | Bank (amount + charges); FX gain/loss |
| Refund to customer / vendor | AR / Bank | Bank / AP |
| Manufacturing order | Inventory (finished goods) | Inventory (components); Manufacturing absorption (labour + overhead) |
| Pay run (approval) | Salaries (gross); Employer PF; Employer ESI | EPF/ESI/PT/TDS payable; Salary payable (net) |
| Pay run payment | Salary payable (net of withheld) | Bank/cash |
| Depreciation | Depreciation expense | Accumulated depreciation |
| Asset acquisition | Asset account | Acquisition account (bank/AP) |
| Asset disposal | Accumulated depreciation; proceeds account; loss | Asset cost; gain |
| Opening stock | Inventory | Opening balance adjustments |
| Contact opening balance | AR (customer) / OBA (vendor) | OBA / AP |

Foreign-currency notes: invoice/bill lines and AR/AP post at the document's exchange rate. A payment posts the
allocated portion at each document's rate and the bank side at the payment's rate; the difference goes to
"Exchange Gain or Loss" (realised FX). Payments must be in the same currency as the documents they settle; without an
explicit currency the payment takes the first allocated document's currency.

## Manual journals

`accountant.ts`: at least two lines; each line either debit or credit, positive; AR/AP lines need a contact; Inventory
accounts are not allowed (stock is maintained by inventory transactions); must balance. Status `posted` or `draft`
(drafts do not affect any balance or report). Reversal creates a new journal with debits and credits swapped and a
reference to the original. Numbering series `journal` (`MJ-`).

## Transaction locking

`kv.lock_dates` holds a date per module (`sales`, `purchases`, `banking`, `accountant`, `inventory`, `payroll`) and
`all`. `assertUnlocked(module, date)` refuses (HTTP 423) any create, edit, delete or status change of a transaction dated
on or before the lock date — checked against both the old and the new date on edits. Setting lock dates needs
`accountant: approve`.

## Opening balances

The organisation's **opening balance date** (`inventory_start_date`, set at setup) dates:

- item opening stock (`postItemOpening`): stock moves of kind `opening` and a journal Inventory / Opening balance
  adjustments;
- contact opening balances (`postContactOpening`).

Changing the date in Settings re-posts all of them on the new date (both old and new dates must be unlocked).

## Invariants (enforced by tests)

- Every journal balances; the sum of all debits equals the sum of all credits.
- Balance sheet: assets = liabilities + equity (current-year profit included).
- Inventory Asset (and any other `stock` accounts) equals the sum of accounting stock move values.
