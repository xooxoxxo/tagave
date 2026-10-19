import type { Sql } from 'postgres';
import { isSealed, sealSecret } from '@tagave/core';

/**
 * One-time boot migration (PLT-5): seal a Discogs token or AcoustID key that
 * an older version saved in plain text. Returns how many libraries it sealed.
 */
export async function sealPlaintextLibraryCredentials(sql: Sql, appSecret: string): Promise<number> {
  const libraries = await sql<{ id: string; settings: Record<string, any> }[]>`
    select id, settings from libraries
    where settings->>'discogsToken' is not null
       or settings->>'acoustidKey' is not null`;

  let sealed = 0;
  for (const lib of libraries) {
    const settings = typeof lib.settings === 'string' ? JSON.parse(lib.settings) : lib.settings;
    let needsUpdate = false;

    if (settings.discogsToken && typeof settings.discogsToken === 'string' && !isSealed(settings.discogsToken)) {
      const hint = settings.discogsToken.slice(-4);
      settings.discogsToken = sealSecret(settings.discogsToken, appSecret);
      settings.discogsTokenHint = hint;
      needsUpdate = true;
    }

    if (settings.acoustidKey && typeof settings.acoustidKey === 'string' && !isSealed(settings.acoustidKey)) {
      const hint = settings.acoustidKey.slice(-4);
      settings.acoustidKey = sealSecret(settings.acoustidKey, appSecret);
      settings.acoustidKeyHint = hint;
      needsUpdate = true;
    }

    if (needsUpdate) {
      await sql`update libraries set settings = ${JSON.stringify(settings)}::text::jsonb where id = ${lib.id}`;
      sealed++;
    }
  }
  return sealed;
}
