import { SCHEMA } from './schema.js';

// Rows are dynamic SQL results; a loose type keeps spreads and joins ergonomic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;
export type Param = string | number | bigint | null | Uint8Array;

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const fail = (message: string, status = 400, details?: unknown): never => {
  throw new HttpError(status, message, details);
};

function clean(v: unknown): Param {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint' || v instanceof Uint8Array) return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

/** A consistent copy of the database for download: a file on disk, or SQL text. */
export interface Backup {
  extension: 'db' | 'sql';
  contentType: string;
  file?: string;
  text?: string;
  cleanup(): void;
}

/**
 * The SQLite engine underneath `DB`. Two implementations exist: `node:sqlite` for the Node.js server (`db-node.ts`) and
 * a Durable Object's SQLite storage on Cloudflare (`db-durable.ts`). Both are synchronous.
 */
export interface SqlDriver {
  /** Runs one or more statements that return no rows. */
  exec(sql: string): void;
  all(sql: string, params: Param[]): Row[];
  get(sql: string, params: Param[]): Row | undefined;
  run(sql: string, params: Param[]): { changes: number; lastInsertRowid: number };
  /** Runs fn atomically. Nested calls roll back only their own changes when they throw. */
  transaction<T>(fn: () => T): T;
  schemaVersion(): number;
  setSchemaVersion(version: number): void;
  backup(): Backup;
  close(): void;
}

export class DB {
  constructor(readonly driver: SqlDriver) {
    driver.exec(SCHEMA);
  }

  exec(sql: string) {
    this.driver.exec(sql);
  }
  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.driver.all(sql, params.map(clean)) as T[];
  }
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.driver.get(sql, params.map(clean)) as T | undefined;
  }
  /** Single scalar value from the first column of the first row. */
  value<T = any>(sql: string, ...params: unknown[]): T {
    const r = this.get(sql, ...params);
    return (r ? Object.values(r)[0] : undefined) as T;
  }
  run(sql: string, ...params: unknown[]) {
    return this.driver.run(sql, params.map(clean));
  }
  insert(table: string, obj: Row): number {
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    return Number(this.run(sql, ...keys.map((k) => obj[k])).lastInsertRowid);
  }
  update(table: string, id: number | string, obj: Row, idCol = 'id') {
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    if (!keys.length) return;
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`, ...keys.map((k) => obj[k]), id);
  }
  /** Runs fn inside a transaction; nested calls roll back only their own changes when they throw. */
  tx<T>(fn: () => T): T {
    return this.driver.transaction(fn);
  }
  schemaVersion() {
    return this.driver.schemaVersion();
  }
  setSchemaVersion(version: number) {
    this.driver.setSchemaVersion(version);
  }
  backup() {
    return this.driver.backup();
  }
  close() {
    this.driver.close();
  }
}

let current: DB | null = null;
/** Opens the application database on a driver and makes it the one `db()` returns. */
export function useDatabase(driver: SqlDriver): DB {
  current = new DB(driver);
  return current;
}
export function db(): DB {
  if (!current) throw new Error('Database not initialised');
  return current;
}

const sqlLiteral = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof ArrayBuffer || v instanceof Uint8Array) {
    const bytes = v instanceof Uint8Array ? v : new Uint8Array(v);
    return `X'${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
};

/**
 * Plain SQL dump of the application tables (schema, rows, then indexes), readable by the `sqlite3` shell:
 * `sqlite3 restored.db < backup.sql`. Internal tables of SQLite and of the hosting platform are skipped.
 */
export function dumpSql(all: (sql: string) => Row[]): string {
  const objects = all(
    `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY type = 'table' DESC, rowid`);
  const out = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
  for (const t of objects.filter((o) => o.type === 'table')) {
    out.push(`${t.sql};`);
    const quoted = `"${String(t.name).replace(/"/g, '""')}"`;
    for (const row of all(`SELECT * FROM ${quoted}`)) {
      const cols = Object.keys(row);
      out.push(`INSERT INTO ${quoted} (${cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')}) VALUES (${cols.map((c) => sqlLiteral(row[c])).join(',')});`);
    }
  }
  for (const o of objects.filter((x) => x.type !== 'table')) out.push(`${o.sql};`);
  out.push('COMMIT;', '');
  return out.join('\n');
}

export const json = <T = any>(s: string | null | undefined, fallback: T): T => {
  if (s == null || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
