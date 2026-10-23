import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { purgeExpiredSessions } from './auth.js';
import { runRecurring } from './dashboard.js';
import { db } from './db.js';
import { completeSetup, initDatabase, needsSetup, setupToken } from './seed.js';

const env = process.env;
const file = env.DB_FILE ?? path.resolve(process.cwd(), 'data/saral.db');
if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
initDatabase(file);

// Unattended install: with ADMIN_EMAIL and ADMIN_PASSWORD (plus ORG_NAME and ORG_STATE_CODE) the first-run setup is
// completed from the environment, so the server never waits for the setup screen.
if (needsSetup() && env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
  try {
    completeSetup({
      organisation: {
        name: env.ORG_NAME ?? '', state_code: env.ORG_STATE_CODE ?? '', gstin: env.ORG_GSTIN, inventory_start_date: env.ORG_OPENING_DATE,
        fiscal_year_start_month: env.ORG_FY_START_MONTH ? Number(env.ORG_FY_START_MONTH) : undefined,
      },
      admin: { name: env.ADMIN_NAME ?? 'Administrator', email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
    });
    console.log(`Organisation set up from environment variables; administrator ${env.ADMIN_EMAIL} created.`);
  } catch (e: any) {
    console.error(`Unattended setup failed: ${e?.message ?? e}. Set ORG_NAME and ORG_STATE_CODE (e.g. 29) with ADMIN_EMAIL/ADMIN_PASSWORD.`);
    process.exit(1);
  }
}
if (needsSetup()) console.log(`First-run setup: open the app in a browser and enter this setup code: ${setupToken()}`);

// Emails interrupted by a previous shutdown may or may not have gone out; mark them failed so a person can decide.
db().run("UPDATE email_outbox SET status = 'failed', error = 'Interrupted while sending; check before retrying' WHERE status = 'sending'");

// Hourly housekeeping: generate due recurring invoices and drop expired sessions.
const tick = () => {
  try {
    const created = runRecurring();
    if (created.length) console.log(`Generated ${created.length} recurring invoice(s)`);
    purgeExpiredSessions();
  } catch (e) {
    console.error('Scheduled job failed', e);
  }
};
tick();
const timer = setInterval(tick, 3600_000);
timer.unref();

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';
const server = createApp().listen(port, host, () => console.log(`Saral ERP listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));

// Graceful shutdown: stop accepting requests, let in-flight ones finish, then close the database cleanly.
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  clearInterval(timer);
  server.close(() => {
    try { db().close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
