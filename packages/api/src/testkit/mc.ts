/**
 * Music Connections is off by default (Settings › Modules): a suite that
 * exercises it turns it on first, making the install's first library if
 * there is none (the switch lives in that library's settings).
 */
import type postgres from 'postgres';
import { setMcEnabled } from '@tagave/db';

export async function turnMcOn(sql: postgres.Sql, ownerUserId: string): Promise<void> {
  const [lib] = await sql`select id from libraries limit 1`;
  if (!lib) await sql`insert into libraries (owner_user_id, name) values (${ownerUserId}, 'Home')`;
  await setMcEnabled(sql, true);
}
