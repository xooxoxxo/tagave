import { runMigrations } from './migrations-lib.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL environment variable is required');
// Dev/CI helper: no pre-migration backup here (the app takes one when it
// starts), but it holds the same advisory lock, so it never races an app start.
await runMigrations(DATABASE_URL, { allowNewerSchema: process.env['LINER_ALLOW_SCHEMA_SKEW'] === '1' });
console.log('migrations up to date');
