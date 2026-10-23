# 02 · Getting started

## Requirements

- **Node.js 22.13 or newer.** The server uses the built-in `node:sqlite` module; no database server is needed.
- npm 10+ (ships with Node 22).
- For browser tests: Chromium via Playwright (`npx playwright install chromium`), or set `CHROMIUM_PATH` to an
  existing Chromium binary.

## Repository layout

```
package.json            npm workspaces root: scripts for both packages
server/                 API (Express 4 + TypeScript, ESM)
  src/                  application code (see 03 Architecture)
    documents/          generic document engine (types, engine, posting, actions)
  test/                 Vitest suites
    fixtures/           sample company used only by tests
    e2e-server.ts       server used by the Playwright tests
web/                    browser app (React 18 + Vite + Tailwind)
  src/                  pages, components, API client
  e2e/                  Playwright end-to-end tests
documentation/          this documentation
Dockerfile              production image
.github/workflows/ci.yml  CI: typecheck, unit tests, build, browser tests
```

## First run (development)

```bash
npm install
npm run dev
```

`npm run dev` starts the API on <http://localhost:4000> (auto-reload with `tsx watch`) and the Vite dev server on
<http://localhost:5173>, which proxies `/api` to the API. Open <http://localhost:5173>.

On an empty database the server prints a **setup code** to its console:

```
First-run setup: open the app in a browser and enter this setup code: 3F9A-61C2-B07E
```

The browser opens the **Set up your organisation** screen. Enter the setup code, the organisation details (name,
state, optional GSTIN, address, financial-year start, opening balance date, valuation method) and the first
administrator's name, email and password. Setup signs you in. After that the setup endpoint is closed for good.

The database file is `server/data/saral.db` (created automatically). Delete it (and `-wal`/`-shm` files) to start over.

## Production build

```bash
npm run build      # builds web/dist and server/dist
npm start          # node server/dist/index.js, serves the API and the built web app on :4000
```

The API serves the built web app from `web/dist` (or `../web/dist` relative to the working directory), with a
catch-all route for client-side routing.

## Scripts

| Command (root) | What it does |
|---|---|
| `npm run dev` | API with auto-reload on :4000 and Vite on :5173 |
| `npm run build` | Production build of web and server |
| `npm start` | Runs the built server |
| `npm test` | Backend unit and integration tests (Vitest) |
| `npm run typecheck` | `tsc --noEmit` for server and web |
| `npm run e2e` | Playwright browser tests (needs `npm run build` first) |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `HOST` | `0.0.0.0` | Interface to listen on |
| `DB_FILE` | `server/data/saral.db` | SQLite file; `:memory:` for a throw-away database |
| `SETUP_TOKEN` | random, printed at start | Fixes the first-run setup code (useful for automated installs) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | — | Unattended install: complete setup from the environment |
| `ORG_NAME`, `ORG_STATE_CODE` | — | Required with `ADMIN_EMAIL` for unattended install (state code e.g. `29`) |
| `ORG_GSTIN`, `ORG_OPENING_DATE`, `ORG_FY_START_MONTH` | — | Optional extras for unattended install |
| `TRUST_PROXY` | unset | Set (e.g. `1` or `loopback`) when behind a reverse proxy so client IPs come from `X-Forwarded-For` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | — | Email delivery; without `SMTP_HOST` emails stay queued in the outbox |
| `WEBHOOK_ALLOW_PRIVATE` | unset | `1` allows workflow webhooks to call private/internal addresses |

## A guided tour of the code

Read these files in order to understand the system in about an hour:

1. `server/src/schema.ts` — every table.
2. `server/src/db.ts` — the tiny database wrapper and transaction helper.
3. `server/src/ledger.ts` — chart of accounts, posting journals.
4. `server/src/documents/types.ts` — the 18 document types and their statuses.
5. `server/src/documents/engine.ts` — create/update/convert/void documents.
6. `server/src/documents/posting.ts` — how a document becomes stock moves and a journal.
7. `server/src/inventory.ts` — stock moves and FIFO/average replay.
8. `server/src/app.ts` — all HTTP routes and their permissions.
9. `web/src/pages/docs/DocForm.tsx` and `DocView.tsx` — the generic document screens.
