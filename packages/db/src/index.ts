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
  // Implicitly-named columns must map to the snake_case identifiers the SQL
  // migrations created (users.displayName -> display_name, ...).
  const db = drizzle(client, { schema, casing: 'snake_case' });

  return {
    db,
    client,
  };
}
