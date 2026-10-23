# 14 · Platform services

Cross-cutting features used by every module.

## First-run setup

`server/src/seed.ts`, `web/src/pages/Setup.tsx`.

- `bootstrap()` (every start) creates only configuration: chart of accounts, INR, GST rates (0, 0.25, 3, 5, 18, 40%;
  12% and 28% inactive), common TDS sections, "Primary Warehouse", numbering series, default roles, salary components,
  Karnataka PT slabs, three asset types and an empty organisation profile. It never creates users or business data.
- While no user exists, `GET /api/setup` returns `{ needs_setup: true, states }` and the browser shows the setup screen.
- `POST /api/setup { setup_code, organisation, admin }`:
  - `setup_code` must match the one-time code printed in the server log at start-up (or `SETUP_TOKEN`); otherwise 403.
    This stops anyone who reaches a freshly started server from claiming it.
  - The organisation is validated by `validateOrgProfile` (same rules as Settings → Organisation): name, state (not
    96/97), GSTIN with matching state, PAN, PIN, email, financial-year start month, opening balance date (defaults to the
    start of the current financial year), valuation method.
  - Creates the first administrator, sets the primary warehouse's state, and returns a session (`{ token, user }`).
  - After the first user exists it returns 409.
- Unattended install: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ORG_NAME`, `ORG_STATE_CODE` (+ optional `ORG_GSTIN`,
  `ORG_OPENING_DATE`, `ORG_FY_START_MONTH`, `ADMIN_NAME`) complete setup at start-up; invalid values stop the process.

## Authentication

`server/src/auth.ts`.

- Passwords: scrypt (64-byte key, 16-byte random salt), stored as `salt:hash`, compared in constant time. Minimum 8,
  maximum 200 characters.
- Sign-in `POST /api/auth/login { email, password }` → `{ token, user }`. Emails are case-insensitive. Tokens are 32 random
  bytes (hex), valid for 7 days, accepted **only** in the `Authorization: Bearer` header (never in URLs).
- Unknown emails are checked against a dummy hash so response times do not reveal which emails exist.
- **Throttling** (15-minute windows): 8 failures per email + client IP, 30 per email from any address, 100 per client
  IP across emails → `429`. Successful sign-in clears the email counters and marks that email + IP pair as known for
  30 days; known pairs are exempt from the per-IP limit, so users behind one shared address (office NAT, or a proxy
  without `TRUST_PROXY`) are not all locked out by someone guessing from the same address. Trackers are in memory,
  bounded (50,000 keys) and evict expired, then unblocked entries first.
- **Forced password change**: users created by an administrator, users whose password an administrator reset, and
  accounts found by migration 2 to still use a former built-in password have `must_change_password`. Until they change
  it, every API call except `/auth/password`, `/auth/me`, `/auth/logout` and `/meta` returns 403
  `{ details: { code: 'password_change_required' } }`; the web app shows a "Choose a new password" screen.
- `POST /api/auth/password { current, next }` checks the current password (8 wrong attempts per user in 15 minutes →
  `429`), enforces strength, refuses reusing the same
  password, clears the flag and signs out the user's other sessions.
- Deactivating a user, changing their role or resetting their password deletes their sessions.
- Expired sessions are purged at sign-in and hourly.

## Roles and permissions

Modules: `items, sales, purchases, inventory, manufacturing, accountant, banking, assets, payroll, compliance, reports,
settings, custom`. Actions: `view, create, edit, delete, approve`. A role's `permissions` JSON maps module → actions;
`is_admin` roles can do everything.

| Default role | Permissions |
|---|---|
| Admin | everything (cannot be edited or deleted) |
| Accountant | full: accountant, banking, assets, compliance, sales, purchases; view: items, inventory, payroll, reports, manufacturing |
| Sales Executive | sales view/create/edit; view: items, inventory, reports |
| Purchase Officer | purchases view/create/edit/delete; view: items, inventory, reports |
| Warehouse Manager | full: items, inventory; sales and purchases view/create/edit; view: reports |
| Production Manager | full: manufacturing; inventory view/create/edit; view: items, reports, sales |
| HR Manager | full: payroll; view: reports |

Where permissions are checked:

- routes use `perm(module, action)`; document routes map the type to its module (`assertDocPerm`); contacts map
  customer → sales and vendor → purchases; payments map received → sales and made → purchases;
- item price/batch/serial lookups need view on any of items, sales, purchases, inventory, manufacturing;
- document actions check the action's permission on the type's module;
- **administrators only**: creating/editing users, creating/editing/deleting roles, `/admin/*` (system info, backups);
- there must always be at least one active administrator.

## Approvals

See [05 Document engine](05-documents-engine.md#approvals). Configured in Settings → Approvals.

## Workflow rules

`server/src/activity.ts → runWorkflows`, rules in `workflow_rules`, results in `workflow_log`.

- **Module**: a document type (`invoice`, `bill`, …), `payment_received`, `payment_made`, or `custom:<module key>`.
- **Trigger**: `on_create`, `on_update`, `on_create_or_update`, `on_status_change` (document status actions).
- **Conditions** (all must hold): `{ field, op, value }` with `op` in `eq, neq, gt, gte, lt, lte, contains, empty,
  not_empty`; `field` can be any record column or `custom.<key>`.
- **Actions**:
  - `notify` → `to`: `creator`, `role:<id>`, `user:<id>`, or administrators; `title`/`body` support `${field}`
    placeholders (e.g. `Invoice ${number} for ${contact_name}`);
  - `email` → `to`: `contact` (the record's contact email) or an address; queued in the outbox;
  - `field_update` → `custom.<key>` on any record, or `reference`, `salesperson`, `notes`, `terms` on documents;
  - `webhook` → `POST` JSON `{ rule, module, trigger, record, sent_at }` to an `http(s)` URL after the change, with a
    10-second timeout and no redirects (`postWebhook`). The target must be a public address: loopback, private,
    link-local, CGNAT, benchmarking, multicast, IPv6 local ranges, and IPv6 forms that embed such an IPv4 address
    (IPv4-mapped/compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`; Teredo is refused) are rejected unless
    `WEBHOOK_ALLOW_PRIVATE=1`. The check runs inside the connection's own DNS lookup, so the address checked is the
    address connected to (no DNS-rebinding window). The outcome is logged.

## Custom fields and custom modules

- **Custom fields** (`custom_fields`) add fields to `customer`, `vendor`, `item` and any document type. Types: text,
  textarea, number, decimal, currency, date, checkbox, dropdown (with options), email, phone, url, lookup_customer,
  lookup_vendor, lookup_item. Values are stored in the record's `custom` JSON and shown on forms.
- **Custom modules** (`custom_modules`): a key (lowercase), name, plural, number prefix and fields (same types, with
  `required`). Records (`custom_records`) are validated per field type, numbered from a per-module series
  (`custom:<key>`, never reused after deletion), audited, run workflows, and use the `custom` permission module.

## Notifications, email, audit, comments

- **Notifications** (`notifications`): approvals, workflow alerts, recurring-invoice failures, completed MOs. Read via
  `GET /api/notifications`; mark read individually or all.
- **Email** (`email_outbox`): every email is stored first. With `SMTP_*` configured it is delivered after the request's
  transaction (a row is claimed `queued → sending` so it is never sent twice) and marked `sent` or `failed` with the
  error; without SMTP it stays `queued`. Settings → Email Log lists them and retries unsent ones. Emails interrupted by
  a shutdown are marked failed at the next start.
- **Audit log** (`audit_log`): every create/update/delete/status change with user and summary; per-record history on
  document pages and the Audit Trail report.
- **Comments**: on any document (`comment` action).

## Numbering

`sequences` holds `prefix`, `next_no`, `padding` per series. Defaults: QT-, SO-, PKG-, INV-, CN-, RMA-, DC-, RET-, PR-,
RFQ-, PO-, GRN-, BILL-, VC-, EXP-, TO-, ADJ-, SC-, PAY- (received), PM- (made), MJ- (journals), BOM-, MO-, JC-, QI-,
FA-, PRUN-, BT-. `nextNumber(type)` skips forward past numbers already used (so moving the counter back cannot cause
duplicates). For invoices, credit notes, delivery challans and retainer invoices the resulting number must satisfy GST
rule 46 (≤ 16 characters; letters, digits, `-`, `/`).

## Settings stored in `kv`

| Key | Content | Edited by |
|---|---|---|
| `org` | Organisation profile (`OrgSettings` in `settings.ts`) | settings: edit |
| `payroll` | Payroll and statutory parameters (`DEFAULT_PAYROLL`) | payroll: edit |
| `lock_dates` | Lock date per module and `all` | accountant: approve |
| `approvals` | Approval mode and levels per document type | settings: edit |

## Search and dashboard

- `GET /api/search?q=` (≥ 2 characters): contacts, items, documents, payments, manufacturing orders, employees.
- `GET /api/dashboard`: ageing buckets (current, 1–15, 16–30, 31–45, 45+ days), monthly income/expense and cash in/out
  for the financial year (transfers between own bank/cash accounts excluded; draft journals excluded), top expenses,
  bank balances, sales activity, inventory summary, low stock, top items, manufacturing counts, pending approvals,
  bills due in 7 days, and insights (overdue receivables, bills due, low stock, pending approvals, uncategorised bank
  lines, upcoming GSTR-1/3B due dates with a link to that period, cash runway).
- `GET /api/meta`: everything the web app needs at start (user, organisation, document type definitions, states, GST
  treatments, account types, taxes, TDS sections, warehouses, currencies, price lists, custom fields and modules, bank
  transaction kinds, approval and lock settings, unread notifications).
