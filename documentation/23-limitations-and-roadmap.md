# 23 · Limitations and roadmap

An honest list of what the product does not do yet, followed by a prioritised technical-debt and improvement backlog.

## Functional limitations

| Area | Limitation | Workaround today |
|---|---|---|
| Government portals | No direct IRP / e-way bill / GSTN API calls (needs GSP credentials) | Download JSON, upload on the portal, record IRN/EWB in the app |
| GST filing | Returns are prepared and exported, not filed | Upload GSTR-1 JSON with the portal's offline tool; file GSTR-3B on the portal |
| Cess | Compensation cess not computed (fields are 0) | Use a separate account line if needed |
| TCS | Tax collected at source not supported | Manual journal |
| Debit notes to customers | No separate customer debit note type | Raise a supplementary invoice |
| Organisations | One organisation per installation | Run one installation per company |
| Banking | CSV statements only; no bank feeds | Import statements periodically |
| Email | Plain-text emails without PDF attachments | Print/PDF from the browser and attach manually |
| Payroll | New tax regime only; no Form 16/24Q/ECR files; PT slabs preset for Karnataka only; no leave management | Configure slabs per state; use reports for returns |
| Inventory | No bins/putaway, no units-of-measure conversion, no landed cost on separate later bills | Use warehouses; include freight lines on the bill |
| Manufacturing | Single-level BOM explosion in MRP; no subcontracting/job-work receipts | Plan sub-assemblies as their own MOs |
| Approvals | Per document type, not by amount thresholds | Use workflow rules to notify on large amounts |
| Access control | Module-level permissions; no record ownership rules | Separate roles per team |
| Authentication | No MFA or SSO; sessions in browser storage | Strong passwords, HTTPS, short-lived sessions |
| Localisation | English UI, INR base currency, Indian states | — |

## Prioritised backlog

Scored as *Priority = (Impact + Risk) × (6 − Effort)*, each 1–5.

| # | Item | Impact | Risk | Effort | Priority | Why |
|---|---|---|---|---|---|---|
| 1 | Amount-based approval rules (e.g. POs above ₹1 lakh) | 4 | 2 | 2 | 24 | Common control requirement; the engine already supports levels |
| 2 | Customer debit notes and TCS | 3 | 3 | 2 | 24 | Completes GST/TDS coverage |
| 3 | HttpOnly-cookie sessions with CSRF protection, plus optional TOTP MFA | 3 | 4 | 3 | 21 | Stronger account protection than bearer tokens in localStorage |
| 4 | Payroll compliance files (EPF ECR, ESI, Form 24Q) and PT slabs for more states | 4 | 3 | 3 | 21 | Payroll users file these monthly/quarterly |
| 5 | Structured JSON logging with request ids | 2 | 2 | 1 | 20 | Easier operations and incident analysis |
| 6 | Persist login throttling (database table) so limits survive restarts and multiple processes | 2 | 3 | 2 | 20 | Today the counters are per process and in memory |
| 7 | PDF generation for invoices and attachment to emails | 4 | 2 | 3 | 18 | Customers expect PDFs by email |
| 8 | Direct e-invoice and e-way bill API integration through a GSP (with credential storage) | 5 | 3 | 4 | 16 | Removes manual upload, the main day-to-day friction for B2B sellers |
| 9 | Shared validation/CSV helpers between server and web (a small shared package) | 2 | 2 | 2 | 16 | `toCsv` and some formats exist in both packages |
| 10 | Background job queue for long re-valuations and bulk imports | 3 | 2 | 3 | 15 | Keeps requests short on large datasets |
| 11 | Split `app.ts` routes into per-module routers | 2 | 1 | 2 | 12 | `app.ts` is ~700 lines; easier navigation and ownership |
| 12 | Multi-organisation support | 4 | 2 | 5 | 6 | Large change (organisation id on every table); only if the business needs it |

## Phased plan

1. **Next release (low effort, high value)**: #1 amount-based approvals, #2 debit notes and TCS, #5 structured logging,
   #6 persistent login throttling, #9 shared helpers.
2. **Following release**: #3 cookie sessions and MFA, #4 payroll compliance files, #7 PDFs.
3. **Larger initiatives**: #8 GSP integration, #10 job queue, #11 router split alongside other work, #12 only if required.
