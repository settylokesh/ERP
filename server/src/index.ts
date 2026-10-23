import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { db } from './db.js';
import { initDatabase } from './db-node.js';
import { hourlyJobs, startUp } from './startup.js';

const file = process.env.DB_FILE ?? path.resolve(process.cwd(), 'data/saral.db');
if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
initDatabase(file);
if (!startUp()) process.exit(1);

hourlyJobs();
const timer = setInterval(hourlyJobs, 3600_000);
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
