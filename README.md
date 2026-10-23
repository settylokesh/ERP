# Saral ERP

An open-source, full-stack ERP for Indian businesses, modelled on the feature set of **Zoho ERP** (launched
January 2026): finance on a real double-entry ledger, GST compliance (GSTR-1, GSTR-3B, e-invoicing, e-way bills),
inventory with FIFO valuation, sales, procurement, manufacturing, payroll, banking, fixed assets, budgets,
approvals, workflows and custom modules.

It is an independent implementation built from Zoho's public product and help documentation — it does not use
Zoho's code, branding or APIs. See [docs/RESEARCH.md](docs/RESEARCH.md) for the research behind it, with sources.

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`; no database server needed).

```bash
npm install
npm run build          # builds the web app and the API
npm start              # http://localhost:4000 — serves the app and the API
```

On first start the API creates `server/data/saral.db` and loads a demo company (*Kaveri Pumps & Motors*, a pump
manufacturer in Bengaluru) by running real business flows through the engine. Set `DEMO=0` to start empty.

| User | Password | Role |
|---|---|---|
| admin@saral.local | admin123 | Admin |
| accounts@saral.local | demo1234 | Accountant |
| sales@saral.local | demo1234 | Sales Executive |
| purchase@saral.local | demo1234 | Purchase Officer |
| stores@saral.local | demo1234 | Warehouse Manager |
| production@saral.local | demo1234 | Production Manager |
| hr@saral.local | demo1234 | HR Manager |

Change these passwords (Settings → Users) before using it for real data.

**Development:** `npm run dev` runs the API on :4000 (auto-reload) and Vite on :5173 with `/api` proxied.

Environment variables: `PORT` (4000), `DB_FILE` (`server/data/saral.db`, or `:memory:`), `DEMO` (`0` disables demo
data), `ADMIN_EMAIL` / `ADMIN_PASSWORD` (first admin user). `npm run seed -- --reset` rebuilds the demo database.

## What's included

| Area | Features |
|---|---|
| **Home** | Receivables/payables aging, income vs expense and cash-flow charts, top expenses, bank balances, sales activity, inventory summary, low stock, pending approvals, rule-based assistant insights (overdue dues, cash runway, return due dates) |
| **Items** | Goods/services, HSN/SAC, GST rate or exempt/nil/non-GST, sales/purchase/inventory accounts, opening stock per warehouse, reorder levels, preferred vendor, batch or serial tracking, price lists (markup % or per-item), CSV import |
| **Sales** | Customers (GST treatment, GSTIN check-digit validation, place of supply, terms, credit limit, currency, opening balance, statements), quotes, sales orders, packages & shipments, delivery challans, invoices, recurring invoices, retainer invoices, payments received (bank charges, customer TDS, excess as credit), sales returns, credit notes (apply/refund) |
| **Purchases** | Vendors, purchase requests, RFQs with invited vendors, surrogate bids, bid comparison and line-wise award → POs, purchase orders, receives (GRN) with quality inspection, bills (ITC eligibility, reverse charge, TDS sections, landed cost by value or quantity), payments made, vendor credits (returns or price corrections), expenses |
| **Inventory** | Physical vs accounting stock (as in Zoho), committed and incoming stock, multi-warehouse, transfer orders (in transit → transferred), quantity and value adjustments, stock counts that post variances, FIFO or weighted-average costing with automatic re-costing of back-dated transactions |
| **Manufacturing** | Work centres (cost/hour, capacity), BOMs with wastage, routing and overheads, manufacturing orders (from scratch or a sales order), material availability, job cards with start/pause/complete and time logs, shop floor board, work-centre calendar with capacity, quality rules and inspections, production costing (material + labour + overhead), MRP with make/buy suggestions |
| **Accountant** | Chart of accounts (Indian defaults), manual journals (draft/publish, reverse), account ledgers, budgets with budget vs actual, transaction locking per module |
| **Banking** | Bank/cash/card accounts, statement CSV import with de-duplication, match suggestions, categorise into payments/expenses/transfers/income, reconciliation against statement closing balance with undo |
| **Fixed assets** | Asset types, SLM and WDV depreciation schedules, monthly depreciation runs, disposal with gain/loss |
| **People & payroll** | Employees, CTC-based salary structures, EPF/EPS/EDLI/admin, ESI, professional tax slabs per state (Karnataka preset), new-regime TDS with rebate and marginal relief, pay runs with LOP, withheld salary, approval → journal, salary payment, payslips |
| **Filing & compliance** | GSTR-1 (B2B, B2CL, B2CS, exports, CDNR/CDNUR, HSN B2B/B2C, documents issued) with GSTN-style JSON export, GSTR-3B (tables 3.1, 3.2, 4, 5 and 6.1 set-off per Rule 88A), GSTR-2B reconciliation, e-invoice IRN generation/cancellation, e-way bills (validity by distance, Part-B updates, cancellation) |
| **Reports** | 44 reports (43 standard + budget vs actual): P&L, balance sheet, cash flow, ratios, trial balance, general ledger, day book, sales/purchases by customer/vendor/item/salesperson, AR/AP aging, customer/vendor balances, stock summary, inventory valuation (reconciled to the ledger), FIFO movements, warehouse stock, inventory aging, committed stock, reorder, batches & serials, MO summary, work-centre utilisation, salary register, EPF/ESI/PT/TDS, GST and HSN summaries, TDS payable, audit trail, email log — all with CSV export and print |
| **Platform** | Role-based permissions (view/create/edit/delete/approve per module), simple and multi-level approvals, workflow rules (notifications, emails, field updates, webhooks), custom fields, custom modules, document numbering, audit history and comments on every transaction, global search, notifications, printable GST tax invoices with e-invoice QR code |

## How it works

- **One ledger.** Every transaction posts a balanced journal; reports are computed from journal lines, so the
  trial balance and balance sheet always balance (enforced by tests).
- **Two stock views.** Like Zoho, receives and shipments move *physical* stock; bills and invoices move
  *accounting* stock. Direct bills/invoices (without a PO/SO) move both.
- **Valuation by replay.** Stock values are recomputed per item in date order (FIFO layers or moving average)
  whenever a transaction changes, and affected journals are re-posted — so a back-dated purchase correctly re-costs
  later sales and manufactured goods. The Inventory Asset ledger always equals the stock valuation report.
- **GST.** Intra-state supplies split into CGST + SGST, inter-state into IGST; exports/SEZ default to LUT
  (zero-rated) with an option to pay IGST; unregistered/composition vendors charge no GST unless reverse charge
  applies.

```
server/   Express API (TypeScript, node:sqlite)
  src/documents/  generic engine for all 18 transaction types (types, posting rules, actions)
  src/ledger.ts, inventory.ts, tax.ts, payments.ts, banking.ts, accountant.ts,
  src/manufacturing.ts, payroll.ts, gst.ts, reports.ts, dashboard.ts, custom.ts
  test/           82 Vitest tests (accounting, GST, FIFO, payroll, manufacturing, banking, API)
web/      React + Vite + Tailwind single-page app
  e2e/            Playwright end-to-end flows
docs/RESEARCH.md  Zoho ERP research and statutory sources
```

## Testing

```bash
npm test                 # backend unit/integration tests
npm run typecheck        # server + web
npm run build && npm run e2e   # browser tests (Playwright; set CHROMIUM_PATH to use a local Chromium)
```

## Honest limits

This covers the core of Zoho ERP, but it is not a byte-for-byte copy of a product built by a large team.
Things that are intentionally simulated or not included:

- **Government and bank integrations run in sandbox mode.** IRNs are computed with the e-invoice formula
  (SHA-256 of GSTIN, fiscal year, document type and number) and a QR payload is generated, but nothing is sent to
  the IRP/NIC portals; that needs GSP credentials. GST returns are prepared and exported as JSON for upload, not
  filed. Bank feeds come from CSV statements rather than connected-banking APIs.
- **Email** is recorded in an outbox (Settings → Email Log); no SMTP server is configured.
- **Not built:** Zia generative AI (the dashboard has rule-based insights instead), POS, customer/vendor portals,
  multi-organisation, bins/putaways/move orders, subscriptions billing, projects and timesheets, travel & expense
  claims, payment gateways, mobile apps, Zoho Analytics/Creator-style low-code beyond custom modules and workflows.
- **Statutory values change.** Defaults reflect public guidance as of October 2026 (see docs/RESEARCH.md). The EPF
  wage-ceiling increase to ₹25,000 from 17 Sep 2026 is from BDO/KPMG summaries of S.O. 5109(E); confirm against the
  gazette. Professional tax is preset only for Karnataka. Foreign exchange rates are placeholders. Review Settings
  → Payroll & Statutory and Settings → Taxes before real use.
- Have a chartered accountant review the chart of accounts, tax mappings and payroll setup for your business.
