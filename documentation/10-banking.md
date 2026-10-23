# 10 · Banking

Code: `server/src/banking.ts`. UI: `web/src/pages/Banking.tsx`.

## Accounts

Bank, cash and credit-card accounts are ordinary chart-of-accounts entries of type `bank`, `cash` or `credit_card`
(bank name, account number and IFSC are optional fields). `GET /api/banking/accounts` returns each with its ledger
balance, statement balance, number of uncategorised statement lines and last reconciled date.

## Bank transactions

Money movements that are not customer/vendor payments are recorded as `bank_transactions` (`POST /api/banking/transactions`):

| Kind | Direction | Other account must be |
|---|---|---|
| `transfer_in` / `transfer_out` | in / out | another bank, cash or card account |
| `deposit` | in | any (except AR, AP, stock) |
| `other_income`, `interest_income` | in | income or other income |
| `owner_contribution` | in | equity |
| `loan` | in | long-term or other current liability |
| `expense` | out | expense, COGS, other expense, fixed asset, other current asset |
| `owner_drawings` | out | equity |
| `card_payment` | out | credit card |
| `tax_payment` | out | other current liability (e.g. GST, TDS, EPF payable) |
| `loan_repayment` | out | long-term or other current liability |

Each posts a two-line journal (bank vs the other account) with numbering series `bank_txn` (`BT-`). Receivable,
payable and inventory accounts are refused — use payments or inventory documents for those.

## Statement import

`POST /api/banking/accounts/:id/import` with a CSV body (`text/csv`, or JSON `{ csv }`):

- Needs a **Date** column and either an **Amount** column (positive = deposit, negative or `(…)` = withdrawal) or
  **Deposit**/**Credit** and **Withdrawal**/**Debit** columns. Optional **Description**/Narration/Particulars and
  **Reference**/Cheque columns. Header names are matched case-insensitively by substring.
- Dates: `YYYY-MM-DD` or `DD/MM/YYYY`, `DD-MM-YY` etc. Amounts may contain `₹`, commas and spaces.
- Duplicates (same account, date, amounts, description and reference) are skipped, so the same file can be imported
  twice safely. Returns `{ imported, skipped, batch }`.

## Matching and categorising

Statement line statuses: `uncategorized` → `matched` (linked to an existing posting) or `categorized` (a new
transaction was created from it) or `excluded`.

- `GET /api/banking/lines/:id/matches` suggests postings on the same bank account, same direction and amount, within ±7
  days, not already matched, nearest date first.
- `POST /api/banking/lines/:id/match { source_type, source_id }` links a suggestion.
- `POST /api/banking/lines/:id/categorize` creates the accounting entry from the line: a customer payment (deposits) or
  vendor payment (withdrawals) with optional allocations, or a bank transaction of any kind above.
- `POST /api/banking/lines/:id/status { status: 'excluded' | 'uncategorized' }` — excluded lines are ignored.

A match stays valid only while the linked transaction still posts the same amount in the same direction to that bank
account. Editing, deleting, voiding or drafting the transaction releases the statement line back to `uncategorized`
automatically (`ledger.ts → syncBankMatches`).

## Reconciliation

- `GET /api/banking/reconcile?account_id&end_date` returns the opening balance (closing balance of the last completed
  reconciliation) and all posted, unreconciled ledger lines of the account up to the end date (credit-card amounts are
  sign-flipped).
- `POST /api/banking/reconcile { account_id, end_date, closing_balance, cleared_line_ids[] }` completes it only if
  opening + cleared amounts equals the statement closing balance (to the paisa); cleared journal lines get `recon_id`.
  End dates must move forward.
- `DELETE /api/banking/reconciliations/:id` undoes the latest reconciliation (later ones must be undone first).

Reconciled lines protect their sources: payments, bank transactions, manual journals and documents with a reconciled
line cannot be edited or deleted until the reconciliation is undone. Re-posting a source (e.g. a cost revaluation)
keeps its reconciliation marks.
