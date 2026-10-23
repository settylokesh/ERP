# 12 · Payroll

Code: `server/src/payroll.ts`, settings in `server/src/settings.ts → DEFAULT_PAYROLL`. UI: `web/src/pages/Payroll.tsx`.
All statutory values are editable under Settings → Payroll & Statutory; sources are in
[22 Statutory reference](22-statutory-reference.md).

## Employees

Employee code (unique), name, joining date (required), exit date, department, designation, work state (for professional
tax), PAN, UAN (12 digits), ESI number, bank details (IFSC validated), annual CTC, component overrides, and switches for
EPF, ESI, PT and TDS. **Opening year-to-date** (`ytd_fy` like `2026-27`, `ytd_gross`, `ytd_tds`): salary and TDS of the
current tax year **not** paid through this system (months before payroll started here, or a previous employer).

## Salary structure (`structure`)

Salary components (`salary_components`), calculated in this order on the monthly CTC (annual ÷ 12):

| `calc` | Meaning | Default component |
|---|---|---|
| `pct_ctc` | % of monthly CTC | BASIC 50% |
| `pct_basic` | % of Basic | HRA 50% of Basic |
| `fixed` | fixed monthly amount | CONV (0 by default) |
| `balance` | whatever is left of gross (only one allowed) | SPECIAL (Fixed Allowance) |

Gross is derived from CTC: monthly CTC − employer PF (when PF is included in CTC; PF wage capped at the ceiling) and, if
ESI applies, ÷ (1 + employer ESI rate). ESI applies when that gross is within the ESI wage limit. If the fixed parts
exceed gross, the CTC is rejected as too low. Per-employee overrides of any component code are allowed.

## Payslip computation (`computePayslip`)

For period `YYYY-MM`:

- **Working days** = days in month, reduced for joining after the 1st or exit before month end; **paid days** =
  working days − LOP (loss of pay) days; every earning is pro-rated by paid days ÷ days in month.
- **EPF**: PF wage = PF-applicable earnings, capped at the wage ceiling in force on the last day of the month when
  "restrict to ceiling" is on (₹15,000; ₹25,000 from 17 Sep 2026 by default). Employee 12%; employer 12% split into EPS
  8.33% of wage up to the EPS cap (₹15,000) and EPF the rest; EDLI 0.5% and admin 0.5% of wage (EDLI capped at the
  ceiling). Amounts rounded to rupees.
- **ESI**: when applicable, employee 0.75% and employer 3.25% of gross, rounded up.
- **Professional tax**: slab of the work state for the gross (`pt_slabs`); February may have a different amount
  (Karnataka preset: ₹200 for ₹25,000+, ₹300 in February).
- **TDS (new regime)**:
  ```
  remaining months = months from this period to March (inclusive)
  projected income = gross on approved/paid payslips this tax year
                   + opening YTD gross (if entered for this tax year)
                     otherwise: current monthly gross × earlier months of employment this year without a payslip
                   + current monthly gross × remaining months
  taxable = projected income − standard deduction (₹75,000)
  annual tax = slab tax − 87A rebate (taxable ≤ ₹12 lakh, up to ₹60,000), with marginal relief just above ₹12 lakh,
               + surcharge (10% > ₹50 lakh, 15% > ₹1 crore, 25% > ₹2 crore), + 4% cess
  monthly TDS = (annual tax − TDS already deducted this year) ÷ remaining months   (never negative)
  ```
- **Net** = gross − deductions; employer cost = employer contributions.

## Pay run lifecycle

1. **Create** for a month (one per month, processed in order: earlier drafts must be approved first, and a month before
   an existing pay run cannot be created). Pay date defaults to the month end. Payslips are computed for every employee
   active in the month.
2. **Edit** a payslip (draft only): LOP days, withhold salary. **Recalculate** re-computes all payslips (after salary or
   settings changes).
3. **Approve** (`payroll: approve`; payroll period not locked): posts the payroll journal
   (Salaries, Employer PF (incl. EDLI/admin), Employer ESI → EPF, ESI, PT, TDS payables and Salary payable).
4. **Record payment** from a bank or cash account: Salary payable → bank for the net of non-withheld payslips.
5. **Release withheld** salary later per payslip (Salary payable → bank).
6. Only draft pay runs can be deleted.

Reports: salary register, EPF, ESI, PT and TDS summaries ([15](15-reports.md)). Payslips can be printed from the UI.
