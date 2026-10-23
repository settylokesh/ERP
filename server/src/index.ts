import { createApp } from './app.js';
import { seedDemo } from './demo.js';
import { initDatabase } from './seed.js';
import { runRecurring } from './dashboard.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const file = process.env.DB_FILE ?? path.resolve(process.cwd(), 'data/saral.db');
if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
initDatabase(file, { adminEmail: process.env.ADMIN_EMAIL, adminPassword: process.env.ADMIN_PASSWORD });
if (process.env.DEMO !== '0' && seedDemo()) console.log('Loaded demo company data');

// Generate due recurring invoices on start and every hour.
const tick = () => { try { const n = runRecurring(); if (n.length) console.log(`Generated ${n.length} recurring invoice(s)`); } catch (e) { console.error('Recurring run failed', e); } };
tick();
setInterval(tick, 3600_000).unref();

const port = Number(process.env.PORT ?? 4000);
createApp().listen(port, () => console.log(`Saral ERP API listening on http://localhost:${port}`));
