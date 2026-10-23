# 17 · Frontend

React 18 single-page app built with Vite 6 and Tailwind CSS 3 (`web/`). No global state library: server data is
fetched per page with a small hook, and organisation metadata is shared through one context.

## Structure

```
web/src/
  main.tsx              router, first-run/sign-in gating, lazy-loaded pages
  api.ts                fetch wrapper, token storage, file download helper
  index.css             Tailwind layers and shared classes (.btn, .input, .card, .table, .chip, print rules)
  lib/hooks.tsx         useApi, useDebounced, MetaProvider/useMeta, useCan
  lib/format.ts         money (en-IN), qty, dates, status colours, titleCase
  components/
    Layout.tsx          sidebar navigation by permission, global search, quick create, notifications, user menu,
                        forced password-change screen
    ui.tsx              Spinner, ErrorBox, Badge, Empty, PageHeader, Field, Input, Textarea, Select, Check, Modal,
                        Tabs, Stat, ToastProvider/useToast, useAction, Confirm, KeyVal
    DataTable.tsx       table with CSV export, row click and keyboard activation
    LineItems.tsx       line editor for all document types (items, accounts, tax, discounts, tracking modal, totals preview)
    pickers.tsx         searchable Combo box; Contact, Item, Account, Warehouse, Tax, State, Employee pickers
    charts.tsx          small SVG charts (column, line, horizontal bar) used on the dashboard
  pages/
    Setup.tsx, Login.tsx           first-run setup and sign-in (share AuthShell)
    Dashboard.tsx                  home
    docs/DocList.tsx               list for any document type (status tabs, search, dates, paging)
    docs/DocForm.tsx               create/edit for any document type (also conversions and cloning)
    docs/DocView.tsx               document page: print view, actions, tabs (related, bids, journal, stock, history)
    docs/PrintDoc.tsx              printable layout (tax invoice, e-invoice QR, amount in words)
    Items, Contacts, Payments, Recurring, Accountant, Banking, Assets, Manufacturing, Payroll,
    Compliance, Reports, Settings, Custom
```

## Routing and gating (`main.tsx`)

- On load without a token, the app calls `GET /api/setup`. If setup is needed every route redirects to `/setup`;
  otherwise unauthenticated users go to `/login`.
- Signed-in routes are wrapped in `MetaProvider` (loads `/api/meta` once) and `Layout`. If
  `meta.user.must_change_password` is true, `Layout` shows only the password-change screen.
- A `401` from any API call clears the token and returns to `/login` (`setUnauthorizedHandler`).
- Pages are code-split with `React.lazy`.

| Route | Page |
|---|---|
| `/` | Dashboard |
| `/docs/:type`, `/docs/:type/new`, `/docs/:type/:id`, `/docs/:type/:id/edit` | Document list/form/view for any type |
| `/items/*`, `/price-lists` | Items and price lists |
| `/customers/*`, `/vendors/*` | Contacts |
| `/payments/:kind/*` | Payments received / made |
| `/recurring` | Recurring invoices |
| `/accountant/*` | Chart of accounts, journals, budgets, locking |
| `/banking/*` | Bank accounts, statements, reconciliation |
| `/assets/*` | Fixed assets |
| `/manufacturing/*` | Orders, BOMs, work centres, shop floor, calendar, quality, MRP |
| `/payroll/*` | Employees, pay runs, payslips |
| `/compliance/*` | GSTR-1, GSTR-3B (`?period=YYYY-MM`), GSTR-2B, e-invoices & e-way bills |
| `/reports/*` | Report catalogue and viewer |
| `/settings/*` | Organisation, users, roles, taxes, locations, approvals, workflows, custom fields/modules, numbering, payroll, email log, system & backup |
| `/custom/:key/*` | Custom module records |

## Data fetching

```tsx
const { data, error, loading, reload, setData } = useApi<MyType>(`/docs/invoice?status=${status}`);
const { run, busy } = useAction();          // wraps a call with toast on success/error and a busy flag
await run(() => post('/docs/invoice', body), 'Invoice saved');
```

`api.ts` always sends the bearer token in the header; `download(path, name, body?)` fetches a file (GET, or POST when a
body is given) and saves it via a blob URL, so tokens never appear in URLs.

## Permissions in the UI

`useCan()(module, action)` mirrors the server rules to hide menus and buttons. The server is still the authority; the
UI only avoids showing actions that would fail.

## Generic document screens

- `DocForm` builds the header fields from the type definition in `meta.doc_types` (party, warehouse, due date,
  reverse charge, TDS, landed cost, challan type…) and uses `LineItems` for lines. Totals shown while typing come from
  `computeTotals` (a preview); the saved document always has server-computed totals.
- Query parameters: `?from=<id>&from_type=<type>` loads a conversion draft; `?clone=<id>` copies a document.
- `DocView` renders the available actions from the document's `actions` list; simple actions use a confirmation, others
  a form (`ACTION_FORMS`). e-Invoice and e-way bill files are downloaded from the **More** menu.

## Printing

`window.print()` with print CSS (`.no-print` hides chrome, `.print-area` is the page). `PrintDoc` renders the tax
invoice layout: seller and buyer with GSTIN and structured addresses, place of supply, HSN, CGST/SGST or IGST columns,
amount in words (from the server), IRN and acknowledgement, the signed e-invoice QR code (rendered with `qrcode`), and
e-way bill number.

## Accessibility

- All form controls have labels (`Field` wraps inputs in a `<label>`; table inputs use `aria-label`).
- Text colours meet WCAG AA contrast (no `text-slate-400` on light backgrounds); links inside text are underlined.
- Clickable table rows are focusable and open with Enter/Space; toasts are announced via `aria-live`.
- Checked with axe-core (WCAG 2.1 A/AA) across the main screens: no violations at the time of writing.

## Styling

Tailwind with a small design vocabulary in `index.css`: `.btn`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.btn-sm`,
`.input`, `.label`, `.card`, `.table`, `.num`, `.chip`, `.tab`, `.link`. Colours: `brand-*` (blue) and `side-*`
(sidebar). Status chip colours come from `statusClass()` in `lib/format.ts`.
