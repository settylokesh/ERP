import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { login } from '../src/auth.js';
import { db, dumpSql, type Row } from '../src/db.js';
import { DurableObjectDriver, type DurableSqlStorage } from '../src/db-durable.js';
import { NodeSqliteDriver } from '../src/db-node.js';
import { createDocument } from '../src/documents/engine.js';
import { LATEST_VERSION, migrate } from '../src/migrations.js';
import { createPayment } from '../src/payments.js';
import { buy, fresh, inventoryReconciles, sell, stock, trialBalanced } from './helpers.js';

const { DatabaseSync: Sqlite } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Stand-in for a Durable Object's SQLite storage, with the same rules as Cloudflare's: `sql.exec(query, ...bindings)`
 * returns a cursor, transaction statements and `PRAGMA user_version` are refused, and transactions only run through
 * (nestable) `transactionSync()`.
 */
function durableStorage(): DurableSqlStorage & { raw: DatabaseSync } {
  const raw = new Sqlite(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  const cursor = (rows: Row[]) => Object.assign(rows[Symbol.iterator](), { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() });
  return {
    raw,
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(query) || /PRAGMA\s+user_version/i.test(query)) throw new Error('not authorized: SQLITE_AUTH');
        const statements = query.trim().replace(/;\s*$/, '');
        if (!bindings.length && /;\s*\S/.test(statements)) {
          raw.exec(query);
          return cursor([]);
        }
        return cursor(raw.prepare(query).all(...(bindings as never[])) as Row[]);
      },
    },
    transactionSync<T>(fn: () => T): T {
      const sp = `cf_sp${depth++}`;
      raw.exec(`SAVEPOINT ${sp}`);
      try {
        const out = fn();
        raw.exec(`RELEASE ${sp}`);
        return out;
      } catch (e) {
        raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      } finally {
        depth--;
      }
    },
  };
}

const tableCounts = (all: (q: string) => Row[]) => Object.fromEntries(
  all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_schema_meta' ORDER BY name")
    .map((t) => [t.name, all(`SELECT COUNT(*) AS n FROM "${t.name}"`)[0].n]));

describe('Durable Object driver', () => {
  it('runs the application on Durable Object storage', () => {
    const c = fresh(new DurableObjectDriver(durableStorage()));
    expect(db().schemaVersion()).toBe(LATEST_VERSION);
    expect(migrate(db())).toEqual([]);
    buy(c, 10, 100, '2026-05-01');
    const inv = sell(c, 4, 200, '2026-05-02');
    createPayment({ kind: 'received', date: '2026-05-03', contact_id: c.cust, amount: 944, account_id: c.bank, allocations: [{ document_id: inv, amount: 944 }] }, c.admin);
    expect(stock(c.widget)).toBe(6);
    expect(trialBalanced()).toBe(true);
    expect(inventoryReconciles()).toBe(true);
    expect(login('admin@example.com', 'admin-pass-123', '192.0.2.1').token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rolls back a failed write without losing earlier work', () => {
    const c = fresh(new DurableObjectDriver(durableStorage()));
    const before = db().value<number>('SELECT COUNT(*) FROM documents');
    // An invalid line fails inside the document transaction after the header was written.
    expect(() => createDocument('invoice', { date: '2026-05-02', contact_id: c.cust, lines: [{ item_id: 999999, qty: 1, rate: 1 }] }, c.admin, { submit: true })).toThrow();
    expect(db().value<number>('SELECT COUNT(*) FROM documents')).toBe(before);
    db().tx(() => {
      db().insert('comments', { entity: 'contact', entity_id: c.cust, body: 'kept' });
      expect(() => db().tx(() => { db().insert('comments', { entity: 'contact', entity_id: c.cust, body: 'dropped' }); throw new Error('inner'); })).toThrow('inner');
    });
    expect(db().all('SELECT body FROM comments').map((n) => n.body)).toEqual(['kept']);
  });

  it('keeps the schema version in a table', () => {
    const storage = durableStorage();
    fresh(new DurableObjectDriver(storage));
    expect(storage.raw.prepare("SELECT value FROM _schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: String(LATEST_VERSION) });
    db().setSchemaVersion(1);
    expect(migrate(db())).toEqual([2]);
  });
});

describe('SQL dump backup', () => {
  it('restores into an empty database with every row', () => {
    const c = fresh();
    buy(c, 10, 100, '2026-05-01');
    sell(c, 3, 200, '2026-05-02', c.widget, { notes: "O'Brien; \"quoted\"\nnew line" });
    const all = (q: string) => db().all(q);
    const dump = dumpSql(all);
    const restored = new NodeSqliteDriver(':memory:');
    restored.exec(dump);
    const rall = (q: string) => restored.all(q, []);
    expect(tableCounts(rall)).toEqual(tableCounts(all));
    expect(rall("SELECT notes FROM documents WHERE type = 'invoice'")[0].notes).toBe("O'Brien; \"quoted\"\nnew line");
    expect(rall("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sm_item'")).toHaveLength(1);
  });

  it('is what a Durable Object backup returns', () => {
    const c = fresh(new DurableObjectDriver(durableStorage()));
    buy(c, 2, 50, '2026-05-01');
    const b = db().backup();
    expect(b.extension).toBe('sql');
    const restored = new NodeSqliteDriver(':memory:');
    restored.exec(b.text!);
    expect(restored.all("SELECT COUNT(*) AS n FROM documents WHERE type = 'bill'", [])[0].n).toBe(1);
  });
});
