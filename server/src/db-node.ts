import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Backup, Param, Row, SqlDriver } from './db.js';
import { initDatabaseWith } from './seed.js';

/** SQLite through Node.js's built-in `node:sqlite`, on a file (or `:memory:` for tests). */
export class NodeSqliteDriver implements SqlDriver {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(readonly file: string) {
    // Loaded through require so test bundlers (which do not know the newer node:sqlite builtin) leave it alone.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }
  all(sql: string, params: Param[]): Row[] {
    return this.stmt(sql).all(...params);
  }
  get(sql: string, params: Param[]): Row | undefined {
    return this.stmt(sql).get(...params);
  }
  run(sql: string, params: Param[]) {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  transaction<T>(fn: () => T): T {
    const sp = `sp${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }
  schemaVersion() {
    return Number((this.raw.prepare('PRAGMA user_version').get() as Row)?.user_version ?? 0);
  }
  setSchemaVersion(version: number) {
    this.raw.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
  }
  /** Consistent online copy: SQLite's VACUUM INTO writes a compact copy of the live database to a temporary file. */
  backup(): Backup {
    const dir = mkdtempSync(path.join(tmpdir(), 'saral-backup-'));
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    try {
      const file = path.join(dir, 'backup.db');
      this.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      return { extension: 'db', contentType: 'application/vnd.sqlite3', file, cleanup };
    } catch (e) {
      cleanup();
      throw e;
    }
  }
  close() {
    this.raw.close();
  }
}

/** Opens (creating if needed) the database file, brings its schema up to date and loads base settings. */
export function initDatabase(file: string) {
  return initDatabaseWith(new NodeSqliteDriver(file));
}
