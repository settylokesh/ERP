# Zoho ERP research notes

These notes record what was learned about Zoho ERP before building Saral ERP, and where each fact came from.
`zoho.com` and `help.zoho.com` could not be fetched directly from the build environment (blocked by its network
policy), so the research was done through web search results that quote Zoho's own product and help pages,
plus press coverage. Nothing was copied from Zoho's software; Saral ERP is an independent implementation of the
publicly documented feature set, under its own name.

The "Reverse Engineer Anything" MCP server was **not** installed or used, as requested. (A search for it only
surfaced an unrelated binary-analysis server, `revula`, which would not help with a web SaaS product anyway.)

## What Zoho ERP is

- Launched on **23 January 2026** from Kumbakonam, Tamil Nadu, initially for India.
  ([ETV Bharat](https://www.etvbharat.com/en/business/zoho-launches-made-in-india-erp-to-increase-kumbakonam-workforce-to-2000-enn26012304168),
  [Enterprise Times](https://www.enterprisetimes.co.uk/2026/01/26/zoho-launches-erp-solution-in-india-will-it-roll-out-globally/),
  [Storyboard18](https://www.storyboard18.com/digital/zoho-unveils-homegrown-erp-with-built-in-ai-compliance-and-low-code-tools-88203.htm))
- Positioned as a unified suite: core financials (built on Zoho Books), supply chain (built on Zoho Inventory),
  omnichannel commerce, billing and spend management, people and payroll, asset management, budgeting and
  financial close, with the Zia AI assistant.
  ([Zoho ERP India](https://www.zoho.com/en-in/erp/), [Supply chain](https://www.zoho.com/en-in/erp/solutions/supply-chain-management/))
- Post-launch updates (July 2026) added a work-centre calendar, manufacturing orders from sales orders, quality
  inspections on purchase and sales-return receipts, and HTML PDF templates for custom modules.
  ([Product updates, July 2026](https://help.zoho.com/portal/en/community/topic/zoho-erp-product-updates-july-2026-3-8-2026))

## Module behaviour documented in Zoho ERP help

| Area | Documented behaviour | Source |
|---|---|---|
| Configure modules | Optional modules are switched on under Settings → Organization Settings → Configure Modules; enabling Manufacturing adds BOMs, Manufacturing Orders, Job Cards and Shop Floor | [Configure Modules](https://www.zoho.com/en-in/erp/help/settings-and-configurations/setup-and-configurations/configure-modules.html), [Enable manufacturing](https://www.zoho.com/en-in/erp/help/items/bill-of-materials/enable-manufacturing-module.html) |
| Sales orders | Creating an SO does not reduce stock but tracks availability; shipments reduce stock; invoices can be raised on shipped or confirmed quantities | [Understanding Sales Orders](https://www.zoho.com/en-in/erp/help/sales/sales-orders/understanding-so.html) |
| Delivery challans | Move goods that may not be a sale (job work, supply on approval, branch transfer); can be converted to an invoice | [Delivery Challans](https://www.zoho.com/en-in/erp/help/sales/delivery-challans/understanding.html) |
| e-Invoicing | Invoices, credit and debit notes are pushed to the IRP for an IRN; statuses Yet-to-be-pushed / Pushed / Failed / Cancelled | [e-Invoicing functions](https://www.zoho.com/en-in/erp/help/settings-and-configurations/taxes-and-compliance/e-invoicing/functions-einvoice.html) |
| e-Way bills | Generated from invoices, delivery challans and credit notes | [e-Way bills](https://www.zoho.com/en-in/erp/help/sales/e-way-bills/generate-ewb/ewb-gold.html) |
| GST filing | GSTR-3B summary and payment (bank integrations for payment) | [GSTR-3B filing](https://www.zoho.com/en-in/erp/help/filing-and-compliance/filing-gstr-3b.html) |
| Purchase requests | Internal approval documents raised before choosing a vendor; convert to PO or RFQ | [Purchase requests](https://www.zoho.com/en-in/erp/help/purchases/purchase-requests/understanding-pr.html) |
| RFQ | Vendors invited to bid; bids compared on price/delivery/terms; surrogate (offline) bids; awarded lines converted to POs | [RFQ](https://www.zoho.com/en-in/erp/help/purchases/request-for-quotes/understanding-rfq.html), [Surrogate bids](https://www.zoho.com/en-in/erp/help/purchases/request-for-quotes/surrogate-bids.html), [RFQ operations](https://www.zoho.com/en-in/erp/help/purchases/request-for-quotes/rfq-operations.html) |
| Inventory | Transfer orders between warehouses, move orders between bins, putaways, inventory adjustments (quantity/value; batch and serial), stock counts | [Transfer orders](https://www.zoho.com/en-in/erp/help/inventory/transfer-orders/understanding-transfer-orders.html), [Adjustments](https://www.zoho.com/en-in/erp/help/inventory/inventory-adjustments/understanding-inventory-adjustments.html), [Stock counts](https://www.zoho.com/en-in/erp/help/inventory/stock-counts/stock-counts-operations.html) |
| Manufacturing | MO linked to a BOM; completion raises finished stock and consumes components; job cards per operation with time logs; dashboard by work centre; quality checks before completion when rules exist | [MO overview](https://www.zoho.com/en-in/erp/help/manufacturing-order/understanding-manufacturing-order.html), [MO dashboard](https://www.zoho.com/en-in/erp/help/manufacturing-order/manufacturing-order-dashboard.html), [Job cards](https://www.zoho.com/en-in/erp/help/manufacturing-order/job-cards.html) |
| Accounting | Transaction locking by module (Sales, Purchases, Banking, Accountant) or all; bank reconciliation against statement closing balance; fixed assets with depreciation and disposal; budgets | [Transaction locking](https://www.zoho.com/en-in/erp/help/accounting/transaction-locking.html), [Reconciliation](https://www.zoho.com/en-in/erp/help/accounting/banking/reconciliation-rules.html), [Fixed assets](https://www.zoho.com/en-in/erp/help/accounting/fixed-assets/create-fixed-assets.html), [Budgets](https://www.zoho.com/en-in/erp/help/budgets/company-budgets.html) |
| Approvals | Simple, multi-level, hierarchical and custom approval types; approvers derive from role permissions | [Simple approval](https://www.zoho.com/en-in/erp/help/settings-and-configurations/approvals/simple-approval.html), [SO approvals](https://www.zoho.com/en-in/erp/help/sales/sales-orders/sales-orders-approvals.html) |
| Custom modules | Custom fields with per-role access; workflow rules (email alerts, notifications, field updates, webhooks, functions); blueprints | [Custom modules](https://www.zoho.com/en-in/erp/help/custom-modules/overview.html) |
| Payroll | Salary components (earnings/deductions, PF/ESI applicability, fixed or variable), statutory components (EPF 12%: 3.67% EPF + 8.33% EPS), pay runs with LOP and withheld salary, salary register and EPF/ESI/PT reports | [Statutory components](https://www.zoho.com/en-in/erp/help/settings-and-configurations/setup-and-configurations/statutory-components.html), [Salary components](https://www.zoho.com/en-in/erp/help/settings-and-configurations/setup-and-configurations/salary-components.html), [Pay run actions](https://www.zoho.com/en-in/erp/help/payroll/pay-runs/pay-run-actions.html) |
| Reports | Business overview (P&L incl. Schedule III, balance sheet), accounting (trial balance, general ledger), receivables and payables aging, inventory valuation incl. landed cost, inventory aging | [Accounting reports](https://www.zoho.com/en-in/erp/help/analytic-reports/accounting.html), [Receivables](https://www.zoho.com/en-in/erp/help/analytic-reports/receivables.html), [Inventory valuation](https://www.zoho.com/en-in/erp/help/analytic-reports/inventory-valuation-reports.html) |

## Indian statutory rules used (and how current they are)

All of these are editable in Settings because they change by notification.

| Rule | Value used | Source |
|---|---|---|
| GST slabs | 0, 5, 18, 40% (plus 3% and 0.25%) from 22 Sep 2025; 12% and 28% abolished | [CBIC/press summaries via ClearTax](https://cleartax.in/s/gst-rates), [WION](https://www.wionews.com/india-news/gst-meeting-council-gives-nod-to-two-tier-tax-structure-common-people-farmers-to-be-benefited-says-sitharaman-1756917961983/amp) |
| Income tax FY 2026-27 (new regime) | Nil to ₹4L, 5/10/15/20/25% in ₹4L bands, 30% above ₹24L; rebate up to ₹12L taxable income; ₹75,000 standard deduction; 4% cess | [CAclubindia](https://www.caclubindia.com/articles/new-tax-regime-fy-202627-complete-slab-rebate-marginal-relief-reference-56353.asp), [Tata Capital](https://www.tatacapital.com/blog/wealth-services/personal-income-tax-slabs/) |
| Karnataka professional tax | ₹200/month for salaries ≥ ₹25,000 (₹300 in February) from 1 Apr 2025 | [greytHR update](https://product-updates.greythr.com/en/revised-karnataka-professional-tax-slabs-now-live-KwPXQWqO) |
| ESI | Employee 0.75%, employer 3.25%, gross wages up to ₹21,000 | [calcguru](https://calcguru.in/?p=4238) |
| EPF wage ceiling | ₹15,000; ₹25,000 from 17 Sep 2026 per S.O. 5109(E) as reported by BDO and KPMG — **verify against the gazette** | [BDO alert](https://www.bdo.in/en-gb/insights/alerts-updates/alert-new-epf-ceiling-hiked), [KPMG FAQ](https://assets.kpmg.com/content/dam/kpmgsites/in/pdf/2026/09/KPMG-Flash-News-FAQs-on-EPFO-Wage-Ceiling-Limit.pdf) |
| GSTIN check digit | Mod-36 weighted checksum; validated against the published sample `27AAPFU0939F1ZV` | test suite |
| e-Way bill validity | 1 day per 200 km (20 km for over-dimensional cargo) since 1 Jan 2021, expiring at midnight; validity starts once Part-B (vehicle) is entered | Rule 138(10), CGST Rules — [Taxmann](https://www.taxmann.com/post/blog/process-of-generating-e-way-bill/), [StudyCafe](https://studycafe.in/validity-of-e-way-bill-narrowed-by-increasing-distance-from-100-km-to-200-km-per-day-93584.html) |
| GST set-off | IGST credit first; CGST credit never against SGST and vice versa; reverse-charge tax in cash | Section 49 and Rule 88A, CGST Act/Rules |
| B2C (large) threshold | Inter-state B2C invoices above ₹1 lakh go to GSTR-1 Table 5 (Rule 59(4) as amended by Notification 12/2024-CT, w.e.f. 1 Aug 2024) | [Tally help](https://help.tallysolutions.com/tally-prime/gstr-1/b2c-large-invoices-5a-5b/), [Cashflo](https://www.cashflo.io/magazine/gst-alert-reduced-b2c-invoice-reporting-threshold-in-gstr-1) |

Points that could not be confirmed from official sources are called out in Settings → Payroll & Statutory and
in the README.
