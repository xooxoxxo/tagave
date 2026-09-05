/**
 * Doctor reseal subcommand: re-encrypt all sealed credentials from an old APP_SECRET to a new one
 *
 * Usage:
 *   LINER_OLD_APP_SECRET=old_secret APP_SECRET=new_secret node dist/cli.js reseal
 *
 * The command reads the old APP_SECRET from LINER_OLD_APP_SECRET and the new one from APP_SECRET,
 * then re-encrypts all sealed credentials in the database.
 */

import postgres from 'postgres';
import { openSecret, sealSecret, isSealed } from '@liner/core';

export async function resealCredentials(databaseUrl: string): Promise<void> {
  const oldSecret = process.env.LINER_OLD_APP_SECRET;
  const newSecret = process.env.APP_SECRET;

  if (!oldSecret) {
    throw new Error('LINER_OLD_APP_SECRET environment variable not set');
  }
  if (!newSecret) {
    throw new Error('APP_SECRET environment variable not set');
  }
  if (oldSecret === newSecret) {
    throw new Error('New APP_SECRET must differ from the old one');
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Fetch all libraries with sealed credentials
    const rows = await sql`
      select id, settings
      from libraries
      where settings->>'discogsToken' like 'enc:%'
         or settings->>'acoustidKey' like 'enc:%'
    ` as unknown as Array<{ id: string; settings: Record<string, any> }>;

    if (rows.length === 0) {
      console.log('No sealed credentials found.');
      return;
    }

    console.log(`Re-sealing credentials for ${rows.length} library/libraries...`);

    for (const row of rows) {
      const settings = typeof row.settings === 'string'
        ? JSON.parse(row.settings)
        : row.settings;

      let updated = false;

      // Re-seal discogsToken (idempotent: skip if already sealed with new secret)
      if (settings.discogsToken && isSealed(settings.discogsToken)) {
        try {
          // Check if already resealed with new secret
          try {
            openSecret(settings.discogsToken, newSecret);
            // Already sealed with new secret, skip
          } catch {
            // Not resealed yet; decrypt with old secret and reseal with new
            const plaintext = openSecret(settings.discogsToken, oldSecret);
            settings.discogsToken = sealSecret(plaintext, newSecret);
            updated = true;
          }
        } catch (err) {
          throw new Error(`Failed to reseal discogsToken for library ${row.id}: ${(err as Error).message}`);
        }
      }

      // Re-seal acoustidKey (idempotent: skip if already sealed with new secret)
      if (settings.acoustidKey && isSealed(settings.acoustidKey)) {
        try {
          // Check if already resealed with new secret
          try {
            openSecret(settings.acoustidKey, newSecret);
            // Already sealed with new secret, skip
          } catch {
            // Not resealed yet; decrypt with old secret and reseal with new
            const plaintext = openSecret(settings.acoustidKey, oldSecret);
            settings.acoustidKey = sealSecret(plaintext, newSecret);
            updated = true;
          }
        } catch (err) {
          throw new Error(`Failed to reseal acoustidKey for library ${row.id}: ${(err as Error).message}`);
        }
      }

      if (updated) {
        await sql`
          update libraries set settings = ${JSON.stringify(settings)}
          where id = ${row.id}
        `;
      }
    }

    console.log(`Successfully re-sealed ${rows.length} library(libraries)`);
  } finally {
    await sql.end();
  }
}
