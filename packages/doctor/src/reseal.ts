/**
 * Doctor reseal subcommand: re-encrypt all sealed credentials from an old APP_SECRET to a new one
 *
 * Usage:
 *   LINER_OLD_APP_SECRET=old_secret APP_SECRET=new_secret node dist/cli.js reseal
 *
 * The command reads the old APP_SECRET from LINER_OLD_APP_SECRET and the new one from APP_SECRET,
 * then re-encrypts all sealed credentials in the database: provider tokens
 * and the player server password (libraries.settings) and the authenticator-app secrets and backup codes
 * (auth_two_factors, encrypted with the sign-in secret derived from APP_SECRET).
 */

import postgres from 'postgres';
import { openSecret, sealSecret, isSealed } from '@liner/core';
import { resealTwoFactorSecrets } from '@liner/auth';

/** Provider secrets kept sealed in libraries.settings (playerPassword: Settings › Playback, bring your own server). */
export const SEALED_LIBRARY_KEYS = ['discogsToken', 'acoustidKey', 'playerPassword'] as const;

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
         or settings->>'playerPassword' like 'enc:%'
    ` as unknown as Array<{ id: string; settings: Record<string, any> }>;

    // Authenticator apps first: one transaction, and it refuses (changing
    // nothing) if a secret opens with neither APP_SECRET.
    const twoFactor = await resealTwoFactorSecrets(sql, oldSecret, newSecret);
    if (twoFactor.rows > 0) {
      console.log(
        `Authenticator apps: ${twoFactor.resealed} re-encrypted, ${twoFactor.alreadyCurrent} already on the new secret.`,
      );
    }

    if (rows.length === 0) {
      console.log('No sealed provider credentials found.');
      return;
    }

    console.log(`Re-sealing credentials for ${rows.length} library/libraries...`);

    for (const row of rows) {
      const settings = typeof row.settings === 'string'
        ? JSON.parse(row.settings)
        : row.settings;

      let updated = false;

      // Re-seal each provider secret (idempotent: skip one already sealed with the new secret)
      for (const key of SEALED_LIBRARY_KEYS) {
        const value = settings[key];
        if (!value || typeof value !== 'string' || !isSealed(value)) continue;
        try {
          try {
            openSecret(value, newSecret);
            // Already sealed with new secret, skip
          } catch {
            const plaintext = openSecret(value, oldSecret);
            settings[key] = sealSecret(plaintext, newSecret);
            updated = true;
          }
        } catch (err) {
          throw new Error(`Failed to reseal ${key} for library ${row.id}: ${(err as Error).message}`);
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
