import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { seedDemo } from './demo.js';
import { initDatabase } from './seed.js';

const file = process.env.DB_FILE ?? path.resolve(process.cwd(), 'data/saral.db');
if (process.argv.includes('--reset')) for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
mkdirSync(path.dirname(file), { recursive: true });
initDatabase(file);
console.log(seedDemo() ? `Demo data loaded into ${file}` : 'Database already has data; nothing to do (use --reset to start over)');
