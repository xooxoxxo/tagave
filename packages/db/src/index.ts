import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import path from 'path';
import { fileURLToPath } from 'url';

export { schema };
export * from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

export async function makeDb(databaseUrl: string) {
  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });

  return {
    db,
    client,
  };
}
