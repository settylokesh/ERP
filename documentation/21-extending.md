# 21 · Extending the system

Recipes for the most common changes. Each ends with the tests to add.

## Add a database change

1. Edit `server/src/schema.ts` so new databases get the change (new table, or new column in the `CREATE TABLE`).
   Do **not** add indexes on new columns here (old databases would fail before migrating); put them in the migration.
2. Append a migration to `MIGRATIONS` in `server/src/migrations.ts` with the next version number. Make it idempotent:
   ```ts
   {
     version: 3,
     name: 'Item barcode',
     up: (d) => {
       addColumn(d, 'items', 'barcode', 'TEXT');
       d.exec('CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode)');
     },
   },
   ```
3. Never edit or reorder a released migration.
4. Test: extend `setup.test.ts` ("upgrades a database created by an older version") or add a case that drops the
   column, resets the version with `d.setSchemaVersion(n)`, migrates and asserts the result. Use only SQL that both
   `node:sqlite` and Durable Object SQLite accept: no `BEGIN`/`SAVEPOINT`/`VACUUM` or `PRAGMA user_version` in
   migrations (the driver handles transactions and versions).

## Add a field to an existing record

Usually: schema + migration, the service's save function (validate and include it in `row`), the read function if it
is computed, the form in `web/src/pages/…`, and the docs. For one-off business fields prefer **custom fields**
(Settings → Custom Fields), which need no code.

## Add a document type

1. Add a `DocTypeDef` to `DOC_TYPES` (`documents/types.ts`): module, lock module, party, priced, side, active status,
   posted statuses, status labels, approvable, `from` parents, flags (`dueDate`, `warehouse`, `lineAccount`).
2. Add a numbering prefix to `DEFAULT_SEQUENCES` (`settings.ts`) — `bootstrap()` creates the series on start.
3. If it moves stock, add a `case` to `buildMoves` (`documents/posting.ts`); if it posts to the ledger, add a `case` to
   `buildJournal`. Decide physical vs accounting effects ([07](07-inventory-valuation.md#stock-moves)).
4. If children consume its quantities or it consumes a parent's, extend `CONSUMES` (`engine.ts`) and, if needed,
   `refreshParent`.
5. Add actions to `ACTIONS` (`documents/actions.ts`) for its lifecycle.
6. UI: the generic list/form/view pages work from `meta.doc_types`; add navigation in `components/Layout.tsx → useNav`,
   a print title in `PrintDoc.tsx → TITLES`, and type-specific form fields in `DocForm.tsx` if needed.
7. Tests: create → post → convert → void/delete; assert journals balance and stock reconciles.

## Add a document action

```ts
// documents/actions.ts → ACTIONS
mark_dispatched: {
  label: 'Mark as Dispatched', types: ['delivery_challan'], when: (doc) => doc.status === 'open', perm: 'edit',
  run: (doc, body, user) => setStatus(doc.id, 'dispatched', user, { dispatched_on: body.date ?? today() }, 'dispatched'),
},
```

Add the status label to the type's `statuses`, a form in `DocView.tsx → ACTION_FORMS` if it takes input, and a test.
`setStatus` re-posts the document and runs `on_status_change` workflows.

## Add a report

```ts
// reports.ts → REPORTS
slow_movers: {
  category: 'Inventory', title: 'Slow-moving Items', params: ['to'],
  fn: (q) => {
    const asOf = q.to || today();
    const rows = db().all<Row>(`SELECT …`, asOf);
    return { title: 'Slow-moving Items', subtitle: `As of ${asOf}`, columns: [{ key: 'name', label: 'Item' }, money('value', 'Value')], rows };
  },
},
```

It appears in the catalogue, the viewer and CSV export automatically. Read only `posted` journals
(`j.status = 'posted'`) for ledger figures. Add a test that it runs and, if possible, ties out to the ledger.

## Add an API endpoint

In `app.ts`, inside `createApp()` on the `api` router:

```ts
api.get('/items/:id/history', perm('items'), h((req) => m.itemHistory(id(req))));
```

- Always add a permission check (`perm`, `adminOnly`, `assertCan`, or a lookup guard).
- Put business logic in a service module, not in the route.
- Validate with `fail(message, 422)`; use `db().tx()` for multi-step writes.
- Document it in [16 API reference](16-api-reference.md) and test it in `api.test.ts`.

## Add a permission module

Add the key to `MODULES` (`auth.ts`), decide default role grants in `DEFAULT_ROLES` (existing databases keep their
roles — grant it there with a migration if needed), add it to the role editor list `MODS` in
`web/src/pages/Settings.tsx`, and guard the routes.

## Add a setting

Organisation settings: add the field and default to `OrgSettings` / `DEFAULT_ORG` (`settings.ts`) and validation to
`validateOrgProfile`; `getKv` merges defaults, so existing databases get the default automatically. Add the field to
Settings → Organisation in the UI.

## Add a workflow action type

Extend the allowed list in `custom.ts → saveWorkflow` and implement it in `activity.ts → runWorkflows`. Keep side effects
that leave the process (HTTP, email) asynchronous and after commit, and log the result to `workflow_log`.

## Add a statutory rule or rate

Prefer data over code: GST rates (Settings → Taxes), TDS sections, payroll parameters (Settings → Payroll), PT slabs per
state (Settings → Payroll → PT slabs). Update the defaults and their source in [22](22-statutory-reference.md) when a
notification changes them, and add a test with the new values.

## Coding conventions

- TypeScript, ESM, 2-space indentation, single quotes. Rows from SQL are typed `Row` (`any`).
- Money: round with `r2()` at each stored step; store INR in ledger and stock tables.
- Errors: `fail(message, status)`; messages are user-facing sentences that say how to fix the problem.
- Derived data: rebuild from the source (`syncPosting`, `replaceJournal`) instead of patching.
- Keep comments for the *why*; keep functions small enough to read in one screen where possible.
