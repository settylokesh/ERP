# Saral ERP — Engineering Documentation

This folder is the reference for everyone who builds, runs or extends Saral ERP. It explains what the product does,
how every part works, the rules each module enforces, the database, every API endpoint, and how to test, deploy and
change it safely.

The code is the final authority. When code and documentation disagree, fix whichever is wrong in the same change.

## Where to start

| You want to… | Read |
|---|---|
| Understand what the product is and what it covers | [01 Product overview](01-product-overview.md) |
| Run it on your machine | [02 Getting started](02-getting-started.md) |
| Understand how the code is put together | [03 Architecture](03-architecture.md) |
| Look up a table or column | [04 Data model](04-data-model.md) |
| Change anything about sales, purchase or inventory documents | [05 Document engine](05-documents-engine.md) |
| Understand the books, journals and posting rules | [06 Accounting ledger](06-accounting-ledger.md) |
| Understand stock quantities and FIFO / average costing | [07 Inventory and valuation](07-inventory-valuation.md) |
| Work on payments, credits and refunds | [08 Sales, purchases and payments](08-sales-purchases-payments.md) |
| Work on GST returns, e-invoices or e-way bills | [09 GST, e-invoicing and e-way bills](09-gst-and-e-invoicing.md) |
| Work on bank feeds and reconciliation | [10 Banking](10-banking.md) |
| Work on BOMs, manufacturing orders or quality | [11 Manufacturing](11-manufacturing.md) |
| Work on salaries and statutory deductions | [12 Payroll](12-payroll.md) |
| Work on fixed assets or budgets | [13 Fixed assets and budgets](13-fixed-assets-budgets.md) |
| Work on users, roles, approvals, workflows, custom fields | [14 Platform services](14-platform-services.md) |
| Add or change a report | [15 Reports](15-reports.md) |
| Call the API | [16 API reference](16-api-reference.md) |
| Work on the web app | [17 Frontend](17-frontend.md) |
| Write or run tests | [18 Testing](18-testing.md) |
| Deploy, back up, upgrade or operate a server | [19 Deployment and operations](19-deployment-and-operations.md) |
| Review security controls | [20 Security](20-security.md) |
| Add a document type, report, migration or module | [21 Extending the system](21-extending.md) |
| Check a statutory rate or rule and its source | [22 Statutory reference](22-statutory-reference.md) |
| Know what is not built yet and what to improve next | [23 Limitations and roadmap](23-limitations-and-roadmap.md) |
| Look up a term (ITC, RCM, LOP, UQC…) | [24 Glossary](24-glossary.md) |

## Conventions used in these documents

- Paths such as `server/src/ledger.ts` are relative to the repository root.
- "Base currency" means Indian Rupees (INR). All ledger amounts are stored in INR.
- Money is rounded to 2 decimal places with `r2()` (`server/src/util.ts`) at every step that stores a value.
- Dates are ISO strings `YYYY-MM-DD`; timestamps are ISO 8601 in UTC.
- HTTP status codes: `401` not signed in, `403` not allowed, `404` not found, `409` duplicate/conflict,
  `422` validation failed, `423` period locked, `429` too many sign-in attempts, `500` unexpected error.
