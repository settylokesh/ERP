// Starts the API for the Playwright end-to-end tests: a fresh in-memory database, set up through the same first-run
// setup the product uses, then filled with the sample company fixture.
import { createApp } from '../src/app.js';
import { completeSetup, initDatabase } from '../src/seed.js';
import { loadSampleCompany } from './fixtures/sample-company.js';

export const E2E_ADMIN = { name: 'Test Administrator', email: 'admin@example.com', password: 'admin-pass-123' };

initDatabase(':memory:');
completeSetup({ organisation: { name: 'Sample Company', state_code: '29', inventory_start_date: '2026-04-01' }, admin: E2E_ADMIN });
loadSampleCompany();
const port = Number(process.env.PORT ?? 4100);
createApp().listen(port, () => console.log(`E2E server on http://localhost:${port}`));
