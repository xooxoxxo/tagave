import { runMigrations } from './migrations-lib.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL environment variable is required');
await runMigrations(DATABASE_URL);
console.log('migrations up to date');
