import type postgres from 'postgres';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { deriveAuthSecret } from './config.js';

export interface ResealResult {
  rows: number;
  resealed: number;
  alreadyCurrent: number;
}

async function decrypts(key: string, data: string): Promise<string | null> {
  try {
    const plain = await symmetricDecrypt({ key, data });
    return typeof plain === 'string' && plain.length > 0 ? plain : null;
  } catch {
    return null;
  }
}

/**
 * Re-encrypt authenticator-app secrets and backup codes from the auth secret
 * derived from `oldAppSecret` to the one derived from `newAppSecret`
 * (`liner-doctor reseal`). Idempotent: a row that already opens with the new
 * secret is left alone. A row that opens with neither aborts the whole run
 * (one transaction) so nothing is half-rotated.
 */
export async function resealTwoFactorSecrets(
  sql: postgres.Sql,
  oldAppSecret: string,
  newAppSecret: string,
): Promise<ResealResult> {
  const oldKey = deriveAuthSecret(oldAppSecret);
  const newKey = deriveAuthSecret(newAppSecret);
  const exists = await sql`select to_regclass('public.auth_two_factors') as t`;
  if (!exists[0]?.['t']) return { rows: 0, resealed: 0, alreadyCurrent: 0 };

  return sql.begin(async (tx) => {
    const rows = await tx<Array<{ id: string; user_id: string; secret: string; backup_codes: string }>>`
      select id, user_id, secret, backup_codes from auth_two_factors for update`;
    let resealed = 0;
    let alreadyCurrent = 0;
    for (const row of rows) {
      const secretNow = await decrypts(newKey, row.secret);
      const codesNow = await decrypts(newKey, row.backup_codes);
      if (secretNow !== null && codesNow !== null) {
        alreadyCurrent++;
        continue;
      }
      const secret = secretNow ?? (await decrypts(oldKey, row.secret));
      const codes = codesNow ?? (await decrypts(oldKey, row.backup_codes));
      if (secret === null || codes === null) {
        throw new Error(
          `the authenticator app of user ${row.user_id} cannot be decrypted with the old or the new APP_SECRET; nothing was changed`,
        );
      }
      await tx`
        update auth_two_factors
           set secret = ${await symmetricEncrypt({ key: newKey, data: secret })},
               backup_codes = ${await symmetricEncrypt({ key: newKey, data: codes })}
         where id = ${row.id}`;
      resealed++;
    }
    return { rows: rows.length, resealed, alreadyCurrent };
  });
}
