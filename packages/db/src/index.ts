import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export { schema };
export * from './migrations-lib.js';
export * from './schema.js';

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
