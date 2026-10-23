# 15 · Reports

Code: `server/src/reports.ts` (`REPORTS` registry), UI: `web/src/pages/Reports.tsx`.

## How reports work

- `GET /api/reports` lists `{ key, title, category, params }`.
- `GET /api/reports/:key?from=YYYY-MM-DD&to=YYYY-MM-DD` runs one; `GET /api/reports/:key.csv` downloads it as CSV.
- `from` defaults to the start of the current financial year, `to` to today. Invalid dates or `from > to` → 422.
- Result shape (`ReportResult`):

```json
{
  "title": "Trial Balance",
  "subtitle": "As of 2026-10-23",
  "columns": [{ "key": "account", "label": "Account" }, { "key": "debit", "label": "Debit", "type": "money" }],
  "rows": [{ "account": "Accounts Receivable", "debit": 12000 }],
  "totals": { "debit": 12000, "credit": 12000 },
  "sections": [{ "title": "Income", "rows": [{ "account": "Sales", "amount": 50000 }], "total": 50000 }],
  "meta": { "balanced": true }
}
```

  Statement-style reports (P&L, balance sheet, cash flow) use `sections`; tabular reports use `columns` + `rows`.
  Column `type` is `money`, `number`, `date`, `percent` or text; `link` tells the UI which page a cell opens.
- Ledger-based reports read only `posted` journals.
- CSV export escapes quotes, commas and newlines and prefixes text cells that start with `= + - @` or tab/CR with `'`
  to neutralise spreadsheet formulas (CSV injection); plain numbers stay numeric. Title and subtitle are escaped too.

## Catalogue

| Key | Category | Title | Params |
|---|---|---|---|
| `profit_and_loss` | Business Overview | Profit and Loss | from, to |
| `balance_sheet` | Business Overview | Balance Sheet (`meta.balanced`) | to |
| `cash_flow` | Business Overview | Cash Flow Statement | from, to |
| `business_performance` | Business Overview | Business Performance Ratios | from, to |
| `trial_balance` | Accountant | Trial Balance (`meta.balanced`) | to |
| `general_ledger` | Accountant | General Ledger | from, to |
| `journal_report` | Accountant | Journal Report (Day Book) | from, to |
| `sales_by_customer` | Sales | Sales by Customer | from, to |
| `sales_by_item` | Sales | Sales by Item | from, to |
| `sales_by_salesperson` | Sales | Sales by Salesperson | from, to |
| `sales_order_details` | Sales | Sales Order Details | from, to |
| `ar_aging_summary` / `ar_aging_details` | Receivables | AR Ageing summary / details | to |
| `customer_balances` | Receivables | Customer Balance Summary | to |
| `invoice_details` | Receivables | Invoice Details | from, to |
| `payments_received` | Receivables | Payments Received | from, to |
| `ap_aging_summary` / `ap_aging_details` | Payables | AP Ageing summary / details | to |
| `vendor_balances` | Payables | Vendor Balance Summary | to |
| `bill_details` | Payables | Bill Details | from, to |
| `purchases_by_vendor` / `purchases_by_item` | Payables | Purchases by vendor / item | from, to |
| `purchase_order_details` | Payables | Purchase Order Details | from, to |
| `stock_summary` | Inventory | Stock Summary (opening, in, out, closing) | from, to |
| `inventory_valuation` | Inventory | Inventory Valuation Summary (`meta.reconciled` against the ledger) | to |
| `fifo_cost_lots` | Inventory | Inventory Movement & Cost | from, to |
| `warehouse_stock` | Inventory | Warehouse Stock | — |
| `inventory_aging` | Inventory | Inventory Ageing Summary | to |
| `committed_stock` | Inventory | Committed Stock Details | — |
| `reorder_report` | Inventory | Items Below Reorder Level | — |
| `batch_serial_report` | Inventory | Batch & Serial Number Details | — |
| `mo_summary` | Manufacturing | Manufacturing Order Summary | from, to |
| `work_center_utilization` | Manufacturing | Work Centre Utilisation | from, to |
| `salary_register` | Payroll | Salary Register | from, to |
| `epf_summary`, `esi_summary`, `pt_summary` | Payroll | Statutory summaries | from, to |
| `tds_salary` | Payroll | TDS on Salary (Sec 192) | from, to |
| `gst_summary` | Taxes | GST Summary | from, to |
| `hsn_summary` | Taxes | HSN/SAC Summary | from, to |
| `tds_payable` | Taxes | TDS Payable (Vendors) | from, to |
| `audit_trail` | Activity | Audit Trail | from, to |
| `email_log` | Activity | Email Log | — |

Plus **Budget vs Actual** per budget: `GET /api/budgets/:id/report` ([13](13-fixed-assets-budgets.md#budgets)).

Ageing buckets are: current (not yet due), 1–15, 16–30, 31–45 and over 45 days past due, using each document's due date
and remaining balance.

## Adding a report

See [21 Extending](21-extending.md#add-a-report).
