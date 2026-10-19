/**
 * Doctor reseal subcommand: re-encrypt all sealed credentials from an old APP_SECRET to a new one
 *
 * Usage:
 *   TAGAVE_OLD_APP_SECRET=old_secret APP_SECRET=new_secret node dist/cli.js reseal
 *
 * The command reads the old APP_SECRET from TAGAVE_OLD_APP_SECRET and the new one from APP_SECRET,
 * then re-encrypts all sealed credentials in the database: provider tokens
 * and the player server password (libraries.settings), the authenticator-app secrets and backup codes
 * (auth_two_factors, encrypted with the sign-in secret derived from APP_SECRET), and Music Connections'
 * own links (mc_links.sealed_tokens; mc_pending's client secret and PKCE code verifier), so links keep
 * working after a rotation.
 */

import postgres from 'postgres';
import { openSecret, sealSecret, isSealed } from '@tagave/core';
import { resealTwoFactorSecrets } from '@tagave/auth';
import { tagaveEnv } from '@tagave/shared/env';

/** Provider secrets kept sealed in libraries.settings (playerPassword: Settings › Playback, bring your own server). */
export const SEALED_LIBRARY_KEYS = ['discogsToken', 'acoustidKey', 'playerPassword'] as const;

/** Music Connections' sealed columns: [table, key column, sealed column]. */
export const MC_SEALED_COLUMNS = [
  ['mc_links', 'id', 'sealed_tokens'],
  ['mc_pending', 'state_hash', 'client_secret_sealed'],
  ['mc_pending', 'state_hash', 'code_verifier_sealed'],
] as const;

export interface McResealResult {
  /** re-encrypted with the new secret */
  resealed: number;
  /** already on the new secret */
  alreadyCurrent: number;
  /** opened with neither secret: left as they are (those links ask for approval again) */
  unreadable: number;
}

/**
 * Re-encrypt Music Connections' sealed columns from `oldSecret` to
 * `newSecret`, in one transaction. Idempotent: a value already on the new
 * secret is skipped. A value neither secret opens is left as it is and
 * counted, never an error: a link in needs_reapproval keeps tokens sealed
 * before an earlier rotation, so a re-run, or a first run where those are the
 * only links, meets them. A wrong old secret opens nothing, so it changes
 * nothing; resealCredentials checks the old secret before any step runs.
 */
export async function resealMcSecrets(sql: postgres.Sql, oldSecret: string, newSecret: string): Promise<McResealResult> {
  return sql.begin(async (tx) => {
    const out: McResealResult = { resealed: 0, alreadyCurrent: 0, unreadable: 0 };
    for (const [table, key, column] of MC_SEALED_COLUMNS) {
      const rows = await tx.unsafe<Array<{ k: string; v: string }>>(
        `select ${key}::text as k, ${column} as v from ${table} where ${column} like 'enc:%' for update`,
      );
      for (const row of rows) {
        if (!isSealed(row.v)) continue;
        try {
          openSecret(row.v, newSecret);
          out.alreadyCurrent += 1;
          continue;
        } catch {
          // not on the new secret yet
        }
        let plaintext: string;
        try {
          plaintext = openSecret(row.v, oldSecret);
        } catch {
          out.unreadable += 1;
          continue;
        }
        await tx.unsafe(`update ${table} set ${column} = $1 where ${key}::text = $2`, [sealSecret(plaintext, newSecret), row.k]);
        out.resealed += 1;
      }
    }
    return out;
  });
}

type LibraryRow = { id: string; settings: Record<string, any> };

export interface OldSecretCheck {
  /** sealed values (provider secrets and Music Connections) the old secret opens: it is right */
  opensWithOld: number;
  /** provider secrets (libraries.settings) on neither secret: the run would fail on them */
  libraryUnreadable: string[];
  /** Music Connections values on neither secret (stale links; or a wrong old secret) */
  mcUnreadable: number;
}

function sealedState(value: string, oldSecret: string, newSecret: string): 'new' | 'old' | 'neither' {
  try {
    openSecret(value, newSecret);
    return 'new';
  } catch {
    // not on the new secret
  }
  try {
    openSecret(value, oldSecret);
    return 'old';
  } catch {
    return 'neither';
  }
}

/**
 * Read-only, before any step changes anything: which sealed values the old
 * secret opens. The provider secrets in libraries.settings are the check: one
 * not on the new secret must open with the old one, or the old secret is
 * wrong (or that value is lost) and the run stops with nothing changed.
 */
export async function checkOldSecret(sql: postgres.Sql, libraries: LibraryRow[], oldSecret: string, newSecret: string): Promise<OldSecretCheck> {
  const out: OldSecretCheck = { opensWithOld: 0, libraryUnreadable: [], mcUnreadable: 0 };
  for (const row of libraries) {
    const settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
    for (const key of SEALED_LIBRARY_KEYS) {
      const value = settings?.[key];
      if (typeof value !== 'string' || !isSealed(value)) continue;
      const state = sealedState(value, oldSecret, newSecret);
      if (state === 'old') out.opensWithOld += 1;
      else if (state === 'neither') out.libraryUnreadable.push(`${key} of library ${row.id}`);
    }
  }
  for (const [table, key, column] of MC_SEALED_COLUMNS) {
    const rows = await sql.unsafe<Array<{ k: string; v: string }>>(`select ${key}::text as k, ${column} as v from ${table} where ${column} like 'enc:%'`);
    for (const row of rows) {
      if (!isSealed(row.v)) continue;
      const state = sealedState(row.v, oldSecret, newSecret);
      if (state === 'old') out.opensWithOld += 1;
      else if (state === 'neither') out.mcUnreadable += 1;
    }
  }
  return out;
}

export async function resealCredentials(databaseUrl: string): Promise<void> {
  const oldSecret = tagaveEnv('OLD_APP_SECRET');
  const newSecret = process.env.APP_SECRET;

  if (!oldSecret) {
    throw new Error('TAGAVE_OLD_APP_SECRET environment variable not set');
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
    ` as unknown as LibraryRow[];

    // The old secret first, before anything changes: a provider secret it
    // cannot open stops the run here (the authenticator apps check themselves).
    const check = await checkOldSecret(sql, rows, oldSecret, newSecret);
    if (check.libraryUnreadable.length > 0) {
      throw new Error(
        `${check.libraryUnreadable.join(', ')} open(s) with neither secret; is TAGAVE_OLD_APP_SECRET right? Nothing was changed.`,
      );
    }

    // Authenticator apps: one transaction, and it refuses (changing
    // nothing) if a secret opens with neither APP_SECRET.
    const twoFactor = await resealTwoFactorSecrets(sql, oldSecret, newSecret);
    if (twoFactor.rows > 0) {
      console.log(
        `Authenticator apps: ${twoFactor.resealed} re-encrypted, ${twoFactor.alreadyCurrent} already on the new secret.`,
      );
    }

    // Music Connections links (one transaction). A value neither secret opens
    // is a warning, never a stop: the steps after this one still run.
    const mc = await resealMcSecrets(sql, oldSecret, newSecret);
    if (mc.resealed + mc.alreadyCurrent + mc.unreadable > 0) {
      console.log(`Music Connections: ${mc.resealed} re-encrypted, ${mc.alreadyCurrent} already on the new secret, ${mc.unreadable} opened with neither secret.`);
    }
    if (mc.unreadable > 0) {
      console.warn(
        `Warning: ${mc.unreadable} Music Connections value(s) open with neither secret and were left as they are; those connections ask for approval again.` +
          (check.opensWithOld === 0 && twoFactor.resealed === 0
            ? ' TAGAVE_OLD_APP_SECRET opened no sealed value at all: if these links worked before the rotation, check it and run reseal again.'
            : ''),
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
          update libraries set settings = ${sql.json(settings)}
          where id = ${row.id}
        `;
      }
    }

    console.log(`Successfully re-sealed ${rows.length} library(libraries)`);
  } finally {
    await sql.end();
  }
}
