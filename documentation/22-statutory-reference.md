# 22 · Statutory reference

Indian rules the software implements, the default values, and where they came from. All values that change by
notification are editable in Settings. Defaults reflect public information available in October 2026; an accountant
should confirm them for your business before go-live.

## GST

| Rule | Default / behaviour | Source |
|---|---|---|
| GST rate slabs | 0%, 5%, 18%, 40%, plus 3% and 0.25%, from 22 Sep 2025; 12% and 28% kept inactive for earlier documents | GST Council rationalisation (56th meeting), summarised by [ClearTax](https://cleartax.in/s/gst-rates) and [WION](https://www.wionews.com/india-news/gst-meeting-council-gives-nod-to-two-tier-tax-structure-common-people-farmers-to-be-benefited-says-sitharaman-1756917961983/amp) |
| Intra-state = CGST + SGST; inter-state = IGST | Place of supply vs supplier state | IGST Act, CGST Act |
| Exports and SEZ supplies zero-rated under LUT, or with IGST paid | `data.export_with_payment` | Section 16, IGST Act |
| Reverse charge on notified inward supplies | Bill flag; tax payable in cash | Section 9(3)/9(4), CGST Act |
| ITC utilisation order | IGST first; CGST and SGST never crossed | Section 49 and Rule 88A, CGST Act/Rules |
| GSTIN structure and check digit | 15 characters, mod-36 check digit; verified against the published sample `27AAPFU0939F1ZV` | GSTN format; test suite |
| Invoice numbers | Up to 16 characters, letters, digits, `-` and `/` | Rule 46(b), CGST Rules |
| B2C (large) threshold in GSTR-1 | Inter-state B2C invoices above ₹1,00,000 | Rule 59(4) as amended by Notification 12/2024-CT (from 1 Aug 2024), summarised by [Tally](https://help.tallysolutions.com/tally-prime/gstr-1/b2c-large-invoices-5a-5b/) and [Cashflo](https://www.cashflo.io/magazine/gst-alert-reduced-b2c-invoice-reporting-threshold-in-gstr-1) |
| GSTR-1 / GSTR-3B due dates (monthly filers) | 11th / 20th of the following month | CGST Rules (shown as reminders) |
| e-Invoice schema | Version 1.1 (INV-01) field names; reason codes for IRN cancellation 1 Duplicate, 2 Data entry mistake, 3 Order cancelled, 4 Others; cancellation within 24 hours | NIC e-invoice schema; cross-checked against [india-compliance](https://github.com/resilient-tech/india-compliance) (`gst_india/utils/e_invoice.py`, `constants/e_invoice.py`) |
| e-Way bill bulk JSON | `version 1.0.0621`, `billLists`; sub-supply types, transport modes (1 Road, 2 Rail, 3 Air, 4 Ship), vehicle type R/O, cancellation codes (1 Duplicate, 2 Order cancelled, 3 Data entry mistake, 4 Others), vehicle update reasons (1 Break down, 2 Transhipment, 3 Others, 4 First time) | E-way bill system bulk format; cross-checked against india-compliance (`gst_india/utils/e_waybill.py`, `constants/e_waybill.py`) |
| e-Way bill validity | 1 day per 200 km (20 km for over-dimensional cargo), ending at midnight; starts when Part-B is entered | Rule 138(10), CGST Rules, as amended from 1 Jan 2021 ([Taxmann](https://www.taxmann.com/post/blog/process-of-generating-e-way-bill/), [StudyCafe](https://studycafe.in/validity-of-e-way-bill-narrowed-by-increasing-distance-from-100-km-to-200-km-per-day-93584.html)) |
| e-Way bill value threshold | ₹50,000 (setting; some states differ) | Rule 138(1) |
| HSN code lengths accepted | 4, 6 or 8 digits | GST portal validation (as applied in india-compliance) |
| Unit quantity codes (UQC) | NOS, PCS, KGS, LTR, MTR, BOX, SET, … ; OTH otherwise | GST UQC list |

## Income tax

| Rule | Default | Source |
|---|---|---|
| TDS on vendor payments | Sections 194C (1%/2%), 194J (10%/2%), 194I (10%/2%), 194H (2%), 194Q (0.1%); editable | Income-tax Act, 1961 |
| TDS base excludes GST shown separately | Taxable value | CBDT Circular 23/2017 |
| Salary TDS, new regime FY 2026-27 | Nil to ₹4 lakh, then 5/10/15/20/25% in ₹4 lakh bands, 30% above ₹24 lakh; standard deduction ₹75,000; Section 87A rebate up to ₹60,000 for taxable income ≤ ₹12 lakh with marginal relief; surcharge 10%/15%/25%; cess 4% | Finance Act 2025 slabs, unchanged for FY 2026-27 per [CAclubindia](https://www.caclubindia.com/articles/new-tax-regime-fy-202627-complete-slab-rebate-marginal-relief-reference-56353.asp) and [Tata Capital](https://www.tatacapital.com/blog/wealth-services/personal-income-tax-slabs/) |

## Payroll statutory

| Rule | Default | Source |
|---|---|---|
| EPF | Employee 12%, employer 12% (EPS 8.33% on wages up to ₹15,000, rest to EPF), EDLI 0.5%, admin 0.5% | EPF & MP Act, 1952 and schemes |
| EPF wage ceiling | ₹15,000; ₹25,000 from 17 Sep 2026 — **verify against the Gazette** | S.O. 5109(E) as reported by [BDO](https://www.bdo.in/en-gb/insights/alerts-updates/alert-new-epf-ceiling-hiked) and [KPMG](https://assets.kpmg.com/content/dam/kpmgsites/in/pdf/2026/09/KPMG-Flash-News-FAQs-on-EPFO-Wage-Ceiling-Limit.pdf) |
| ESI | Employee 0.75%, employer 3.25%, gross wages up to ₹21,000 | ESI Act, 1948; rates summarised by [calcguru](https://calcguru.in/?p=4238) |
| Professional tax (Karnataka preset) | ₹200/month for salary ≥ ₹25,000; ₹300 in February; from 1 Apr 2025 | Karnataka Tax on Professions (Amendment) Act 2025, via [greytHR](https://product-updates.greythr.com/en/revised-karnataka-professional-tax-slabs-now-live-KwPXQWqO). Other states: add slabs in Settings |

## Companies Act

| Rule | Default | Source |
|---|---|---|
| Useful lives for depreciation | Plant and machinery 15 years, computers 3 years, furniture 10 years | Schedule II, Companies Act 2013 |
| WDV rate for furniture | 25.89% (10-year life, 5% residual) | Derived from Schedule II life |

## Keeping this current

When a rate or rule changes: update the default in code (`seed.ts`, `settings.ts`, `payroll.ts`), add a note and source
here, and tell administrators which setting to change on existing installations (defaults only apply to new ones).
