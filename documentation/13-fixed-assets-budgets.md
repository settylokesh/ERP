# 13 · Fixed assets and budgets

Code: `server/src/accountant.ts`. UI: `web/src/pages/Assets.tsx`, `web/src/pages/Accountant.tsx`.

## Asset types

Name, asset account, depreciation expense account, accumulated depreciation account, default method (`slm` or `wdv`),
useful life in months and WDV rate. Three types are created at setup with lives from Schedule II of the Companies Act,
2013: Plant and Machinery (SLM, 15 years), Computers (SLM, 3 years), Furniture and Fixtures (WDV 25.89%, 10 years).

## Asset lifecycle

1. **Draft**: name, type, serial, location, purchase date, depreciation start (≥ purchase date), cost (> 0), salvage
   value (< cost), method, useful life, WDV rate (0–100 for WDV), vendor and acquisition account.
2. **Register**: if an acquisition account is given, posts Asset account Dr / acquisition account Cr (e.g. bank or a
   payable) on the purchase date; status `active`. (If the purchase was already booked through a bill to the asset
   account, leave the acquisition account empty.)
3. **Depreciation** (`POST /api/assets/depreciate { upto }`): for every active asset, posts each month-end of the
   schedule up to the date that is not yet posted (one `asset_depreciation` row and journal per asset per month):
   - SLM: (cost − salvage) ÷ useful life months, each month;
   - WDV: annual = book value at the start of each financial year × rate; monthly = annual ÷ 12;
   - never below salvage value; when book value reaches salvage the asset becomes `fully_depreciated`.
4. **Dispose** (`{ date, amount, account_id }`): no depreciation may be posted after the disposal date. Journal:
   Accumulated depreciation Dr (all posted), Asset Cr (cost), proceeds account Dr (amount), and the difference to
   "Gain/Loss on Asset Disposal". Status `disposed`, book value 0.
5. Only drafts can be edited or deleted.

`GET /api/assets/:id` returns posted depreciation, accumulated amount, book value, the full schedule (with posted flags)
and acquisition/disposal journals.

## Budgets

A budget has a name and a fiscal year (the year the financial year starts in) and one line per account with 12 monthly
amounts. `GET /api/budgets/:id/report` (budget vs actual) compares each month with posted journal activity of the
account (income, liability and equity accounts are sign-flipped so positive means "as budgeted direction"), with
totals and variance. It is also listed as a report.
