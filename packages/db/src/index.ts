import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export { schema };
export * from './migrations-lib.js';
export * from './schema.js';
export * from './artistRows.js';
export * from './autoAccept.js';
export * from './mcLinks.js';

export async function makeDb(databaseUrl: string) {
  const client = postgres(databaseUrl);
  // Implicitly-named columns must map to the snake_case identifiers the SQL
  // migrations created (users.displayName -> display_name, ...).
  const db = drizzle(client, { schema, casing: 'snake_case' });
  // drizzle-orm 0.45 also makes the date/timestamp/numeric *array* types pass
  // through raw on this shared client (0.36 did so only for the scalar types).
  // Raw `client` queries bind JS arrays to them (unnest(${xs}::numeric[])) and
  // read them back as arrays, so drop those overrides: postgres.js then
  // registers its own array (de)serializers on connect, as before. Drizzle's
  // array columns accept either form.
  for (const oid of [1115, 1182, 1185, 1231]) {
    delete client.options.parsers[oid];
    delete client.options.serializers[oid];
  }

  return {
    db,
    client,
  };
}
export * from './facetLog.js';
export * from './identityFills.js';
export * from './mcUnplug.js';
export * from './identifyQueue.js';
export * from './wantlist.js';
export * from './listenLinks.js';
export * from './playlistsModule.js';
