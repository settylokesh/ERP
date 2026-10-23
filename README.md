# Saral ERP

Business management software for Indian companies: double-entry accounting, GST compliance, inventory with FIFO or
weighted-average costing, sales, procurement, manufacturing, payroll, banking, fixed assets and budgets — in one web
application backed by a single ledger.

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`; no database server needed).

```bash
npm install
npm run build
npm start            # http://localhost:4000
```

On first start the server prints a one-time **setup code**. Open <http://localhost:4000>, enter the code, your
organisation's details and the first administrator account. There are no built-in users or sample data; the database
starts empty and ready for real work.

For development, `npm run dev` runs the API on :4000 with auto-reload and the web app on :5173.

Docker:

```bash
docker build -t saral-erp .
docker run -d -p 4000:4000 -v saral-data:/data saral-erp
docker logs <container>        # shows the setup code
```

## What it covers

| Area | Highlights |
|---|---|
| Sales | Customers, quotes, sales orders, packages and shipments, delivery challans, invoices, recurring and retainer invoices, payments, returns, credit notes, refunds |
| Purchases | Vendors, purchase requests, RFQs with bid comparison, purchase orders, receives with quality inspection, bills (ITC, reverse charge, TDS, landed cost), vendor credits, expenses |
| Inventory | Physical and accounting stock, warehouses, transfers, adjustments, stock counts, batches and serials, FIFO / weighted average with automatic re-costing |
| Manufacturing | Work centres, BOMs, manufacturing orders, job cards, shop floor, capacity calendar, quality, production costing, MRP |
| Accounting | Chart of accounts, manual journals, ledgers, budgets, period locking, fixed assets and depreciation |
| Banking | Statement import, matching and categorising, bank transactions, reconciliation |
| Payroll | CTC structures, EPF, ESI, professional tax, new-regime TDS, pay runs, payslips |
| GST | GSTR-1 with portal JSON, GSTR-3B with set-off, GSTR-2B reconciliation, e-invoice and e-way bill JSON with IRN/EWB recording |
| Platform | Roles and permissions, approvals, workflow rules and webhooks, custom fields and modules, audit trail, email, search, backups |
| Reports | 44 financial, sales, purchase, inventory, manufacturing, payroll and tax reports with CSV export |

## Documentation

Complete engineering documentation — architecture, data model, business rules of every module, the full API
reference, testing, deployment, security and extension guides — is in [`documentation/`](documentation/README.md).

## Development

```bash
npm test               # backend tests (Vitest)
npm run typecheck      # server and web
npm run build && npm run e2e   # browser tests (Playwright; set CHROMIUM_PATH to use a local Chromium)
```

Repository layout:

```
server/          API: Express + TypeScript + node:sqlite
  src/           services, document engine, ledger, inventory, GST, payroll, …
  test/          Vitest suites, sample-company fixture for tests, e2e server
web/             React + Vite + Tailwind single-page app
  e2e/           Playwright tests
documentation/   engineering documentation
Dockerfile       production image
```

## Before going live

- Complete Settings → Organisation (address and PIN are required for e-invoices and e-way bills), warehouses, taxes,
  numbering and payroll settings for your states.
- Review the statutory defaults in [`documentation/22-statutory-reference.md`](documentation/22-statutory-reference.md)
  with your chartered accountant; GST, TDS, PF, ESI and professional-tax values are editable settings.
- Configure SMTP if the system should send emails, put it behind HTTPS, and schedule backups
  ([`documentation/19-deployment-and-operations.md`](documentation/19-deployment-and-operations.md)).
