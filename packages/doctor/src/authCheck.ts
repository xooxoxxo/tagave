/**
 * Sign-in configuration check: PUBLIC_URL is set and valid, and the passkeys
 * already registered were made for its host name (a WebAuthn credential works
 * only on the RP ID it was created for, so changing the host orphans them).
 */
import postgres from 'postgres';
import { AuthConfigError, parsePublicUrl, passkeysCanWork } from '@liner/auth';
import { plural, type Check } from './checks.js';

export async function checkPublicUrl(databaseUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<Check> {
  const start = Date.now();
  const done = (status: Check['status'], detail: string): Check => ({
    id: 'publicUrl',
    title: 'Public URL',
    status,
    detail,
    durationMs: Date.now() - start,
  });

  if (!env['PUBLIC_URL']?.trim()) {
    return done(
      'warn',
      'PUBLIC_URL is not set here. The web app does not start without it (worker computers do not need it). Set it to the address you open tagave at.',
    );
  }
  let publicUrl;
  try {
    publicUrl = parsePublicUrl(env['PUBLIC_URL']);
  } catch (err) {
    return done('fail', err instanceof AuthConfigError ? err.message : String(err));
  }

  let others: Array<{ rp_id: string; n: number }> = [];
  let total = 0;
  if (databaseUrl) {
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      const exists = await sql`select to_regclass('public.auth_passkeys') as t`;
      if (exists[0]?.['t']) {
        const rows = await sql<Array<{ rp_id: string | null; n: number }>>`
          select rp_id, count(*)::int as n from auth_passkeys group by rp_id`;
        total = rows.reduce((sum, r) => sum + r.n, 0);
        others = rows.filter((r): r is { rp_id: string; n: number } => r.rp_id !== null && r.rp_id !== publicUrl.hostname);
      }
    } catch {
      // the database check reports connection problems
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  if (others.length > 0) {
    const list = others.map((o) => `${plural(o.n, 'passkey')} for ${o.rp_id}`).join(', ');
    return done(
      'warn',
      `PUBLIC_URL is ${publicUrl.origin}, but ${list}: those do not work at ${publicUrl.hostname}. ` +
        'Set PUBLIC_URL back to that host, or sign in with your password and add the passkeys again.',
    );
  }
  if (!passkeysCanWork(publicUrl)) {
    return done(
      'warn',
      `${publicUrl.origin}: browsers allow passkeys and security keys only on https or localhost. Password and authenticator-app sign-in work.`,
    );
  }
  return done('pass', `${publicUrl.origin}${total > 0 ? `, ${plural(total, 'passkey')} registered for it` : ''}`);
}
