import { purgeExpiredSessions } from './auth.js';
import { runRecurring } from './dashboard.js';
import { db } from './db.js';
import { completeSetup, needsSetup, setupToken } from './seed.js';

/**
 * Start-up work shared by the Node.js server and the Cloudflare Durable Object, run after the database is open.
 * Returns false when an unattended setup was requested but failed (the caller decides whether to exit).
 */
export function startUp(env: Record<string, string | undefined> = process.env): boolean {
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
      return false;
    }
  }
  if (needsSetup()) console.log(`First-run setup: open the app in a browser and enter this setup code: ${setupToken()}`);

  // Emails interrupted by a previous shutdown may or may not have gone out; mark them failed so a person can decide.
  db().run("UPDATE email_outbox SET status = 'failed', error = 'Interrupted while sending; check before retrying' WHERE status = 'sending'");
  return true;
}

/** Hourly housekeeping: generate due recurring invoices and drop expired sessions. */
export function hourlyJobs() {
  try {
    const created = runRecurring();
    if (created.length) console.log(`Generated ${created.length} recurring invoice(s)`);
    purgeExpiredSessions();
  } catch (e) {
    console.error('Scheduled job failed', e);
  }
}
