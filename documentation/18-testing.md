# 18 · Testing

## Backend tests (Vitest)

`npm test` runs `server/test/*.test.ts` (about 130 tests, a few seconds). Each file uses a fresh in-memory database.

| File | Covers |
|---|---|
| `tax.test.ts` | Supply kind, line tax incl. tax-inclusive, GSTIN check digit, TDS, set-off order, e-way validity, amount in words |
| `sales.test.ts` | Invoices (intra/inter/export), packages, challans, returns, credit notes, payments, FX gain/loss, refunds, approvals, e-invoice payload/record/cancel, e-way bill JSON/record |
| `purchases.test.ts` | Bills (ITC, RCM, TDS, landed cost), receives with QC, vendor credits (returns and price corrections), RFQ to POs |
| `inventory.test.ts` | FIFO/average, back-dated re-costing, batches/serials, transfers, adjustments, stock counts, negative stock |
| `operations.test.ts` | Banking import/match/categorise/reconcile, manual journals, assets and depreciation, manufacturing, payroll |
| `api.test.ts` | HTTP layer with the sample company: auth, throttling, permissions, admin-only areas, password change, CSV/JSON exports, backups, headers, e-invoice export |
| `setup.test.ts` | Empty install (no built-in users or data), setup code (kept until setup completes), setup validation, migrations, forced change of former default passwords |
| `drivers.test.ts` | The application on the Cloudflare Durable Object driver (over a stand-in with Cloudflare's rules), nested rollback, schema version table, SQL dump backups that restore every row |
| `hardening.test.ts` | Numbering collisions, custom record numbers, duplicate vendor bills and partial bills from one PO, HSN validation on edit, committed/incoming stock, status rules, bank match release, payment currency (and older payments), payroll TDS projection, pay-run order, recurring-profile failures, sign-in and password-change throttling, shared-address exemption, webhook address checks and pinned connections, price-correction valuation |

Helpers (`test/helpers.ts`): `fresh(driver?)` builds a test company (on an in-memory `node:sqlite` database, or on the
given driver) (setup, warehouses, taxes, bank, customers in KA/MH,
consumer, vendors in KA/UP, a stock item and a service) and returns ids; `buy`, `sell`, `bal(key)`, `stock`, `cogsOf`,
`trialBalanced()`, `inventoryReconciles()`.

Rules of thumb:

- Assert accounting effects, not just statuses: `bal('accounts_receivable')`, `trialBalanced()`,
  `inventoryReconciles()`.
- For a bug fix, add the failing scenario first (see `hardening.test.ts`).
- Tests must not depend on the current date except where the feature is date-relative; use fixed dates in 2026.

## Sample company fixture

`server/test/fixtures/sample-company.ts → loadSampleCompany()` creates a realistic manufacturing company (customers,
vendors, items with batches/serials, BOM, orders, invoices, payments, bank statement, payroll, assets, budget, approval
policy and a workflow rule) by calling the real services. It is used by `api.test.ts` and the browser tests only; the
application never loads it. Sample users (`sales@example.com`, `accounts@example.com`, … with password
`sample-pass-123`) exist only in test databases.

## Browser tests (Playwright)

`npm run build && npm run e2e` (set `CHROMIUM_PATH` to use an installed Chromium). `web/playwright.config.ts` starts two
servers:

- port 4100: `server/test/e2e-server.ts` — in-memory database set up through `completeSetup` with
  `admin@example.com` / `admin-pass-123` and the sample company loaded;
- port 4101: the real `src/index.ts` with an empty in-memory database and `SETUP_TOKEN=E2E-SETUP-CODE`, for the
  first-run setup test.

`web/e2e/flows.spec.ts` covers: invoice with GST and payment, journal balance, balance sheet and trial balance, customer
GSTIN validation, role-based navigation, manufacturing inspection and completion, sales order → package → shipment,
e-way bill JSON download and record, GSTR-3B period from the link, bank statement categorisation, pay run approval and
payment, and a new user's forced password change. `web/e2e/setup.spec.ts` covers first-run setup.

## Continuous integration

`.github/workflows/ci.yml` on every push to `main` and every pull request: `npm ci` → `npm run typecheck` → `npm test`
→ `npm run build` → `wrangler deploy --dry-run` (bundles the Cloudflare Worker) → install Chromium → `npm run e2e`.

## Manual checks worth doing before a release

- Upgrade a copy of a production database with the new build and compare the trial balance before/after.
- Export GSTR-1 JSON and an e-invoice JSON for a sample month and validate them with the portals' offline tools.
- Run an accessibility check (axe) on new screens.
- For Cloudflare: `npm run cf:dev` on an empty `.wrangler/state`, then complete setup, post a bill, an invoice and a
  payment, check the trial balance, download a backup, restart `wrangler dev` and confirm the data is still there
  ([25](25-cloudflare.md#local-development-and-testing)).
