import { dumpSql, type Backup, type Param, type Row, type SqlDriver } from './db.js';

/** The part of a Durable Object's `ctx.storage` this driver uses (SQLite-backed Durable Objects only). */
export interface DurableSqlStorage {
  sql: { exec(query: string, ...bindings: unknown[]): Iterable<Row> & { toArray(): Row[] } };
  transactionSync<T>(fn: () => T): T;
}

/**
 * SQLite inside a Cloudflare Durable Object. Queries run in the same thread as the code, synchronously, and the
 * storage is durable and replicated. Two differences from plain SQLite are handled here:
 *  - BEGIN/SAVEPOINT statements are not allowed; `transactionSync()` provides (nestable) transactions instead;
 *  - `PRAGMA user_version` is not allowed; the schema version is kept in the `_schema_meta` table.
 */
export class DurableObjectDriver implements SqlDriver {
  constructor(private storage: DurableSqlStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS _schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  private exec_(sql: string, params: Param[]) {
    // Durable Object bindings take ArrayBuffers for blobs.
    return this.storage.sql.exec(sql, ...params.map((p) => (p instanceof Uint8Array ? p.slice().buffer : p)));
  }

  exec(sql: string) {
    this.storage.sql.exec(sql);
  }
  all(sql: string, params: Param[]): Row[] {
    return this.exec_(sql, params).toArray();
  }
  get(sql: string, params: Param[]): Row | undefined {
    for (const row of this.exec_(sql, params)) return row;
    return undefined;
  }
  run(sql: string, params: Param[]) {
    this.exec_(sql, params).toArray();
    const r = this.storage.sql.exec('SELECT changes() AS c, last_insert_rowid() AS id').toArray()[0];
    return { changes: Number(r?.c ?? 0), lastInsertRowid: Number(r?.id ?? 0) };
  }
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
  schemaVersion() {
    return Number(this.get("SELECT value FROM _schema_meta WHERE key = 'schema_version'", [])?.value ?? 0);
  }
  setSchemaVersion(version: number) {
    this.run("INSERT INTO _schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(Math.trunc(version))]);
  }
  /** SQL dump of all data; Cloudflare also keeps 30 days of point-in-time recovery for Durable Object storage. */
  backup(): Backup {
    return { extension: 'sql', contentType: 'application/sql', text: dumpSql((q) => this.all(q, [])), cleanup: () => undefined };
  }
  close() {
    // Storage lives as long as the Durable Object; there is nothing to close.
  }
}
