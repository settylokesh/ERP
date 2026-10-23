# 16 · API reference

Base URL: `/api`. All request and response bodies are JSON unless stated. Every route is defined in
`server/src/app.ts`; the permission column shows the check applied (`module:action`; "signed in" means any user).

## Conventions

**Authentication.** Send `Authorization: Bearer <token>` (from sign-in or setup). Tokens are never accepted in URLs.

**Errors.** Non-2xx responses have the body `{ "error": "message", "details": … }`.

| Status | Meaning |
|---|---|
| 400 | Malformed request (invalid JSON, invalid id) |
| 401 | Not signed in, session expired, or wrong credentials |
| 403 | Not allowed (permission, admin-only, wrong setup code, password change required → `details.code = "password_change_required"`) |
| 404 | Not found / unknown route |
| 409 | Duplicate or conflicting state (email, SKU, vendor bill number, setup already done) |
| 413 | Body larger than 10 MB |
| 422 | Validation failed; message says what to fix (e-invoice/e-way problems also in `details.problems[]`) |
| 423 | Transaction date is in a locked period |
| 429 | Too many failed sign-in attempts |
| 500 | Unexpected error: `"Something went wrong. Reference: ab12cd34"` (details in the server log under that reference) |

**Lists** return arrays, or `{ rows, total }` where paging applies (`limit`, `offset`).

**Files.** CSV/JSON downloads set `Content-Disposition: attachment; filename="…"`. Uploads of CSV use
`Content-Type: text/csv` with the file as the body.

**Writes** run in one database transaction; on error nothing is saved.

---

## Public

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/health` | — | `{ ok, time, schema_version }` |
| POST | `/auth/login` | `{ email, password }` | `{ token, user }` |
| GET | `/setup` | — | `{ needs_setup, states }` |
| POST | `/setup` | `{ setup_code, organisation: { name, state_code, gstin?, legal_name?, pan?, address?, city?, pincode?, email?, phone?, website?, industry?, fiscal_year_start_month?, inventory_start_date?, valuation_method?, einvoice_enabled? }, admin: { name, email, password } }` | `{ token, user }`; 403 wrong code; 409 already set up |

```bash
curl -s -X POST localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"…"}'
# {"token":"5f2c…","user":{"id":1,"name":"Owner","email":"owner@example.com","role_name":"Admin","is_admin":true,"must_change_password":false,"permissions":{…}}}
```

## Session and metadata

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/auth/logout` | signed in | Deletes the session |
| GET | `/auth/me` | signed in | `{ user, org }` |
| POST | `/auth/password` | signed in | `{ current, next }`; signs out other sessions |
| GET | `/meta` | signed in | Bootstrap data for the web app ([14](14-platform-services.md#search-and-dashboard)) |
| GET | `/dashboard` | signed in | Home dashboard |
| GET | `/search?q=` | signed in | Global search, `[{ type, label, sub, link }]` |
| GET | `/notifications` | signed in | Latest 100 of the current user |
| POST | `/notifications/read-all` | signed in | |
| POST | `/notifications/:id/read` | signed in | |
| GET | `/permissions/check?module&action` | signed in | `{ allowed }` |

## Contacts

Permission module: `sales` for customers, `purchases` for vendors.

| Method | Path | Action | Body / query |
|---|---|---|---|
| GET | `/contacts?kind=customer\|vendor&search&active=all` | view | List with `balance` |
| POST | `/contacts` | create | Contact fields incl. `kind` ([08](08-sales-purchases-payments.md#contacts-mastersts)) |
| POST | `/contacts/import?kind=` | create | CSV body → `{ imported, errors[] }` |
| GET | `/contacts/:id` | view | Contact + `balance`, `unpaid`, recent `documents`, `payments` |
| PUT | `/contacts/:id` | edit | Contact fields |
| DELETE | `/contacts/:id` | delete | Only without transactions |
| GET | `/contacts/:id/statement?from&to` | view | `{ contact, from, to, opening, closing, rows[] }` |
| GET | `/contacts/:id/open-documents?kind=received\|made` | view | Open invoices/retainers or bills |
| GET | `/contacts/:id/credits` | view | Open credit notes/vendor credits and unused payments |

## Items, price lists, accounts and other masters

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/items?search&type&active=all&low_stock` | items:view | With stock on hand, accounting stock, value |
| POST | `/items` | items:create | Item fields ([07](07-inventory-valuation.md#items)) |
| POST | `/items/import` | items:create | CSV (`name, sku, unit, hsn_code, gst_rate, sales_rate, purchase_rate, type, …`) |
| GET | `/items/:id` | items:view | Item + stock summary, warehouses, recent transactions |
| PUT | `/items/:id` | items:edit | |
| DELETE | `/items/:id` | items:delete | Only without transactions |
| GET | `/items/:id/price?price_list_id&side=sales\|purchase` | view any of items/sales/purchases/inventory/manufacturing | `{ rate }` |
| GET | `/items/:id/batches?warehouse_id` | same | `[{ batch_no, expiry_date, qty }]` |
| GET | `/items/:id/serials?warehouse_id` | same | `["SN1", …]` |
| GET | `/price-lists` | signed in | With per-item rates |
| POST / PUT | `/price-lists[/:id]` | items:create / items:edit | `{ name, kind, mode, percentage, items[] }` |
| GET | `/accounts?active=all` | signed in | With `category`, `balance` |
| POST / PUT / DELETE | `/accounts[/:id]` | accountant:create / edit / delete | |
| GET | `/accounts/:id/transactions?from&to` | accountant:view | Ledger with opening, running balance, closing |
| GET | `/warehouses` | signed in | |
| POST / PUT | `/warehouses[/:id]` | settings:edit | `{ name, code, address, city, pincode, state_code, gstin, is_primary, is_active }` |
| GET | `/taxes`, `/tds-sections`, `/currencies` | signed in | |
| POST / PUT | `/taxes[/:id]` | settings:edit | `{ name, rate, is_active }` |
| POST | `/tds-sections` | settings:edit | `{ section, name, rate }` |
| POST | `/currencies` | settings:edit | `{ code, name, symbol, rate }` (upsert) |

## Documents

`:type` is one of the 18 document types ([05](05-documents-engine.md#the-18-document-types)). The permission module is
the type's module (sales, purchases or inventory).

| Method | Path | Action | Notes |
|---|---|---|---|
| GET | `/docs/:type?status&contact_id&from&to&search&ref_doc_id&sort&dir&limit&offset` | view | `{ rows, total }` |
| POST | `/docs/:type` | create | Document input (below); `submit: true` to submit; returns the full document |
| GET | `/docs/:type/:id` | view | Full document with `actions` |
| PUT | `/docs/:type/:id` | edit | Same input; `submit: true` submits a draft |
| DELETE | `/docs/:type/:id` | delete | |
| POST | `/docs/:type/:id/actions/:action` | per action | `{ result, document }` ([actions](05-documents-engine.md#actions-actionsts)) |
| GET | `/docs/:type/:id/convert/:to` | create on target | Unsaved draft of the target type |
| POST | `/docs/:type/:id/convert/:to` | create on target | Creates it (`submit` defaults to true); `{ id, type }` |
| GET | `/docs/:type/:id/einvoice.json` | view | IRP request payload (download) |
| POST | `/docs/:type/:id/ewaybill.json` | view | Body: transport details → e-way bill bulk file (download) |

**Document input**

```json
{
  "date": "2026-10-20", "due_date": null, "contact_id": 12, "warehouse_id": 1, "to_warehouse_id": null,
  "currency_code": "INR", "exchange_rate": 1, "place_of_supply": "27", "reference": "PO-778", "salesperson": "Priya",
  "payment_terms": 30, "ref_doc_id": null, "notes": "", "terms": "", "adjustment": 0,
  "tax_inclusive": false, "reverse_charge": false,
  "data": { "tds_section_id": 3, "landed_method": "value", "challan_type": "Job Work", "paid_through_account_id": 5,
            "mode": "quantity", "vendor_ids": [4, 7], "export_with_payment": false },
  "custom": { "po_ref": "A-1" },
  "lines": [
    { "id": 55, "item_id": 3, "account_id": null, "description": "Pump 1HP", "hsn_code": "8413", "unit": "pcs",
      "qty": 2, "qty2": null, "rate": 7800, "discount_pct": 5, "tax_id": 4, "tax_exempt": null,
      "ref_line_id": null, "warehouse_id": null, "itc_eligible": true,
      "tracking": [{ "serial_no": "SN-1" }, { "serial_no": "SN-2" }], "data": { "landed_cost": false, "return_to_stock": true } }
  ],
  "submit": true
}
```

Only the fields relevant to a type are used; totals and taxes are always computed by the server.

## Payments, credits, refunds

`:kind` is `received` (permission module sales) or `made` (purchases).

| Method | Path | Action | Notes |
|---|---|---|---|
| GET | `/payments/:kind?contact_id&from&to&search&limit&offset` | view | `{ rows (with unused), total }` |
| POST | `/payments/:kind` | create | `{ date, contact_id, amount, bank_charges, tds_amount, mode, account_id, reference, notes, currency_code, exchange_rate, allocations: [{ document_id, amount }] }` |
| GET | `/payments/:kind/:id` | view | With allocations, applications, refunds, unused, journal |
| PUT | `/payments/:kind/:id` | edit | Same body |
| DELETE | `/payments/:kind/:id` | delete | |
| POST | `/credits/apply` | sales:edit | `{ credit_doc_id \| payment_id, allocations[], date }` → `{ applied }` |
| DELETE | `/credits/:id` | sales:edit | Remove a credit application |
| POST | `/refunds` | sales:edit | `{ credit_doc_id \| payment_id, amount, account_id, date, mode, reference }` |
| DELETE | `/refunds/:id` | sales:delete | |

## Accountant, assets, budgets

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/journals?from&to&search` | accountant:view | Manual journals |
| POST / PUT | `/journals[/:id]` | accountant:create / edit | `{ date, reference, memo, status: posted\|draft, lines: [{ account_id, debit, credit, contact_id, description }] }` |
| GET / DELETE | `/journals/:id` | accountant:view / delete | |
| POST | `/journals/:id/reverse` | accountant:create | `{ date }` → `{ id }` |
| GET | `/asset-types` | assets:view | |
| POST / PUT | `/asset-types[/:id]` | assets:create / edit | |
| GET | `/assets` | assets:view | With accumulated depreciation and book value |
| POST / PUT | `/assets[/:id]` | assets:create / edit | Draft assets only for PUT |
| GET | `/assets/:id` | assets:view | With schedule and journals |
| DELETE | `/assets/:id` | assets:delete | Drafts only |
| POST | `/assets/:id/register` | assets:edit | |
| POST | `/assets/:id/dispose` | assets:edit | `{ date, amount, account_id }` |
| POST | `/assets/depreciate` | assets:edit | `{ upto }` → `{ posted }` |
| GET | `/budgets` | accountant:view | |
| POST / PUT | `/budgets[/:id]` | accountant:create / edit | `{ name, fiscal_year, lines: [{ account_id, amounts: [12 numbers] }] }` |
| GET / DELETE | `/budgets/:id` | accountant:view / delete | |
| GET | `/budgets/:id/report` | reports:view | Budget vs actual |

## Banking

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/banking/accounts` | banking:view | Balances and statement status |
| GET | `/banking/kinds` | signed in | Bank transaction kinds |
| GET | `/banking/accounts/:id/statement?status` | banking:view | Statement lines (latest 1000) |
| POST | `/banking/accounts/:id/import` | banking:create | CSV body or `{ csv }` → `{ imported, skipped, batch }` |
| GET | `/banking/lines/:id/matches` | banking:view | Suggestions |
| POST | `/banking/lines/:id/match` | banking:edit | `{ source_type, source_id }` |
| POST | `/banking/lines/:id/categorize` | banking:create | `{ kind, contact_id, allocations, offset_account_id, description }` |
| POST | `/banking/lines/:id/status` | banking:edit | `{ status: excluded \| uncategorized }` |
| GET | `/banking/transactions?account_id` | banking:view | Latest 500 |
| POST / PUT / DELETE | `/banking/transactions[/:id]` | banking:create / edit / delete | `{ kind, date, account_id, offset_account_id, amount, contact_id, description, reference }` |
| GET | `/banking/reconcile?account_id&end_date` | banking:view | Opening and unreconciled lines |
| POST | `/banking/reconcile` | banking:edit | `{ account_id, start_date?, end_date, closing_balance, cleared_line_ids[] }` |
| GET | `/banking/reconciliations?account_id` | banking:view | |
| DELETE | `/banking/reconciliations/:id` | banking:edit | Undo (latest first) |

## Manufacturing

All under `/manufacturing`, permission module `manufacturing`.

| Method | Path | Action | Notes |
|---|---|---|---|
| GET | `/work-centers` | view | With load figures |
| POST / PUT | `/work-centers[/:id]` | create / edit | `{ code, name, cost_per_hour, capacity_hours, is_active }` |
| GET | `/boms` | view | |
| POST / PUT | `/boms[/:id]` | create / edit | `{ item_id, name, quantity, overhead_cost, is_default, status, components: [{ item_id, qty, wastage_pct }], operations: [{ name, work_center_id, minutes }] }` |
| GET / DELETE | `/boms/:id` | view / delete | |
| GET | `/orders?status&search` | view | |
| POST / PUT | `/orders[/:id]` | create / edit | `{ bom_id, qty, date, warehouse_id, sales_order_id, planned_start, planned_end, notes }` |
| POST | `/orders/from-sales-order/:id` | create | `{ created: [ids] }` |
| GET / DELETE | `/orders/:id` | view / delete | With components, availability, job cards, inspections, journal |
| POST | `/orders/:id/confirm` | edit | `{ shortages, order }` |
| POST | `/orders/:id/complete` | edit | `{ date, produced_qty, rejected_qty, consumption: [{ component_id, qty, tracking }], output_tracking, auto_complete_job_cards }` |
| POST | `/orders/:id/cancel` | edit | |
| GET | `/job-cards?status` | view | |
| POST | `/job-cards/:id/:action` | edit | `start`, `pause`, `complete`, `log_time`, `assign` |
| GET | `/shop-floor`, `/calendar?from&to`, `/mrp` | view | |
| GET / POST / PUT | `/quality-rules[/:id]` | view / create / edit | `{ item_id, name, applies_to, parameters: [{ name, type: pass_fail\|numeric, min, max }], is_active }` |
| GET / POST | `/inspections`, `/inspections/:id` | view / create | `{ source_type: mo\|purchase_receive, source_id, source_line_id, qty }` |
| POST | `/inspections/:id/record` | edit | `{ accepted_qty, rejected_qty, results: [{ parameter, value, pass }], inspector, notes }` |

## Payroll

All under `/payroll` (module `payroll`) except where noted.

| Method | Path | Action | Notes |
|---|---|---|---|
| GET | `/employees?status` | view | |
| POST / PUT | `/employees[/:id]` | create / edit | Employee fields incl. `ytd_fy`, `ytd_gross`, `ytd_tds` |
| GET | `/employees/:id` | view | With salary structure and payslips |
| GET | `/departments`, `/designations` | signed in | |
| POST | `/departments`, `/designations` | create | `{ name }` |
| GET / POST / PUT | `/components[/:id]` | view / create / edit | Salary components |
| GET / PUT | `/pt-slabs` | view / edit | PUT `{ state_code, slabs: [{ min_salary, max_salary, amount, feb_amount }] }` |
| GET / POST | `/pay-runs` | view / create | POST `{ period: "YYYY-MM", pay_date }` |
| GET / DELETE | `/pay-runs/:id` | view / delete | With totals, payslips, journals |
| POST | `/pay-runs/:id/recalculate` | edit | |
| POST | `/pay-runs/:id/approve` | approve | Posts the payroll journal |
| POST | `/pay-runs/:id/pay` | edit | `{ account_id, date }` |
| GET / PUT | `/payslips/:id` | view / edit | PUT `{ lop_days, withheld }` |
| POST | `/payslips/:id/release` | edit | `{ account_id, date }` |
| GET / PUT | `/settings/payroll` (under `/api`) | payroll:view / edit | Statutory parameters |

## GST and compliance

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/gst/gstr1?period=YYYY-MM` | compliance:view | Sections, summary, JSON |
| GET | `/gst/gstr1/json?period` | compliance:view | Portal JSON download |
| GET | `/gst/gstr3b?period` | compliance:view | Tables, set-off, cash payable, due date |
| POST | `/gst/gstr2b/reconcile` | compliance:edit | `{ period, entries[] }` |
| GET | `/gst/einvoices` | compliance:view | Invoices, credit notes and challans with e-invoice / e-way status |
| POST | `/gst/einvoice-export[?check=1]` | compliance:view | `{ ids[] }` → JSON array download, or `{ ready[], problems[] }` with `check` |

## Reports, recurring invoices, custom modules

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/reports` | reports:view | Catalogue |
| GET | `/reports/:key[.csv]?from&to` | reports:view | [15](15-reports.md) |
| GET | `/recurring` | sales:view | Profiles |
| POST / PUT / DELETE | `/recurring[/:id]` | sales:create / edit / delete | `{ name, contact_id, frequency, every, start_date, end_date, auto_send, status, template: { lines, … } }` |
| POST | `/recurring/run` | sales:create | `{ upto }` → `{ created: [ids] }` |
| GET | `/custom-modules` | signed in | |
| POST / PUT / DELETE | `/custom-modules[/:id]` | settings:edit | `{ key, name, plural, prefix, fields[] }` |
| GET / POST | `/custom/:key` | custom:view / create | Records (`?search`) / create with field values |
| GET / PUT / DELETE | `/custom/:key/:id` | custom:view / edit / delete | |

## Settings and administration

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET / PUT | `/settings/org` | signed in / settings:edit | Organisation profile; changing the opening date re-posts openings |
| GET / PUT | `/settings/lock-dates` | signed in / accountant:approve | `{ sales, purchases, banking, accountant, inventory, payroll, all }` |
| GET / PUT | `/settings/approvals` | signed in / settings:edit | `{ [type]: { mode, levels: [roleIds] } }` |
| GET | `/settings/sequences` | signed in | |
| PUT | `/settings/sequences/:type` | settings:edit | `{ prefix, next_no, padding }` |
| GET | `/settings/users` | settings:view | |
| POST / PUT | `/settings/users[/:id]` | **admin** | `{ name, email, password, role_id, is_active }` (new users and resets must change password) |
| GET | `/settings/roles` | signed in | With user counts |
| POST / PUT / DELETE | `/settings/roles[/:id]` | **admin** | `{ name, description, permissions }` |
| GET | `/settings/default-roles` | settings:view | |
| GET / POST / PUT / DELETE | `/settings/custom-fields[/:id]` | signed in / settings:edit | `{ module, key, label, type, options, required, sort }` |
| GET / POST / PUT / DELETE | `/settings/workflows[/:id]` | settings:view / edit | `{ name, module, trigger, conditions[], actions[], is_active }` |
| GET | `/settings/workflow-log` | settings:view | Latest 300 |
| GET | `/settings/email-log` | settings:view | `{ configured, rows }` |
| POST | `/settings/email-log/retry` | settings:edit | `{ ids? }` → `{ retried }` |
| GET | `/admin/system` | **admin** | Schema version, counts, `runtime` (`Node.js v…` or `Cloudflare Workers`) |
| GET | `/admin/backup` | **admin** | Downloads a consistent copy: SQLite file `.db` (`VACUUM INTO`) on Node.js, SQL dump `.sql` on Cloudflare |
