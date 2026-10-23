import { RETIRED_DEFAULT_PASSWORDS, verifyPassword } from './auth.js';
import type { DB } from './db.js';

/**
 * Schema migrations.
 *
 * `schema.ts` always describes the latest schema and is applied with CREATE ... IF NOT EXISTS, so a brand-new database
 * is complete before any migration runs. Migrations bring databases created by older versions up to date. Each one must
 * be idempotent (check before altering) because on a new database its changes already exist. The applied version is
 * stored in SQLite's `PRAGMA user_version`.
 *
 * To change the schema: edit `schema.ts`, then append a migration here with the next version number that applies the
 * same change to existing databases. Never edit or reorder a migration that has been released.
 */
export interface Migration {
  version: number;
  name: string;
  up: (d: DB) => void;
}

const hasColumn = (d: DB, table: string, column: string) =>
  d.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column);
const addColumn = (d: DB, table: string, column: string, definition: string) => {
  if (!hasColumn(d, table, column)) d.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'Sign-in time, structured addresses, email delivery status, lookup indexes',
    up: (d) => {
      addColumn(d, 'users', 'last_login_at', 'TEXT');
      for (const c of ['billing_city', 'billing_pincode', 'billing_state', 'billing_country', 'shipping_city', 'shipping_pincode', 'shipping_state']) {
        addColumn(d, 'contacts', c, 'TEXT');
      }
      addColumn(d, 'email_outbox', 'error', 'TEXT');
      addColumn(d, 'email_outbox', 'sent_at', 'TEXT');
      // Salary and TDS of the current tax year paid before payroll moved to this system (or by a previous employer).
      addColumn(d, 'employees', 'ytd_fy', 'TEXT');
      addColumn(d, 'employees', 'ytd_gross', 'REAL NOT NULL DEFAULT 0');
      addColumn(d, 'employees', 'ytd_tds', 'REAL NOT NULL DEFAULT 0');
      addColumn(d, 'warehouses', 'city', 'TEXT');
      addColumn(d, 'warehouses', 'pincode', 'TEXT');
      d.raw.exec('CREATE INDEX IF NOT EXISTS idx_documents_reference ON documents(type, contact_id, reference)');
      d.raw.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
    },
  },
  {
    version: 2,
    name: 'Forced password change, retire former default passwords, lookup indexes',
    up: (d) => {
      addColumn(d, 'users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
      // Earlier versions created accounts with built-in passwords. Any account still using one must choose a new
      // password at its next sign-in.
      for (const u of d.all<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users')) {
        if (RETIRED_DEFAULT_PASSWORDS.some((pw) => verifyPassword(pw, u.password_hash))) d.run('UPDATE users SET must_change_password = 1 WHERE id = ?', u.id);
      }
      d.raw.exec(`CREATE INDEX IF NOT EXISTS idx_bsl_match ON bank_statement_lines(matched_source_type, matched_source_id);
        CREATE INDEX IF NOT EXISTS idx_journals_number ON journals(number);
        CREATE INDEX IF NOT EXISTS idx_bank_txn_number ON bank_transactions(number);
        CREATE INDEX IF NOT EXISTS idx_outbox_status ON email_outbox(status);`);
    },
  },
];

export const LATEST_VERSION = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;

export function schemaVersion(d: DB): number {
  return Number(d.value<number>('PRAGMA user_version') ?? 0);
}

/** Applies pending migrations in order, each in its own transaction. Returns the versions applied. */
export function migrate(d: DB): number[] {
  const applied: number[] = [];
  const current = schemaVersion(d);
  if (current > LATEST_VERSION) {
    throw new Error(`The database is at schema version ${current}, newer than this build supports (${LATEST_VERSION}). Upgrade the application.`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    d.tx(() => {
      m.up(d);
      d.raw.exec(`PRAGMA user_version = ${m.version}`);
    });
    applied.push(m.version);
  }
  return applied;
}
