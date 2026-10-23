import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SCHEMA } from './schema.js';

export type Row = Record<string, any>;
type Param = string | number | bigint | null | Uint8Array;

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

export class DB {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.raw.exec(SCHEMA);
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...params.map(clean)) as T[];
  }
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...params.map(clean)) as T | undefined;
  }
  /** Single scalar value from the first column of the first row. */
  value<T = any>(sql: string, ...params: unknown[]): T {
    const r = this.get(sql, ...params);
    return (r ? Object.values(r)[0] : undefined) as T;
  }
  run(sql: string, ...params: unknown[]) {
    return this.stmt(sql).run(...params.map(clean));
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
  /** Runs fn inside a transaction; nested calls use savepoints so inner failures roll back cleanly. */
  tx<T>(fn: () => T): T {
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
  close() {
    this.raw.close();
  }
}

let current: DB | null = null;
export function openDb(file: string): DB {
  current = new DB(file);
  return current;
}
export function db(): DB {
  if (!current) throw new Error('Database not initialised');
  return current;
}

export const json = <T = any>(s: string | null | undefined, fallback: T): T => {
  if (s == null || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
