/**
 * Music Connections links (0049), shared by the linking routes (api) and the
 * pull job (worker): the audit trail of a link (spec §5 Security: create,
 * approve, refresh failure, revoke, scope change). Entries carry hosts,
 * scopes and reasons, never a token or a secret.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

export type McLinkAuditAction =
  | 'mc.consumer.link_create'
  | 'mc.consumer.link_approve'
  | 'mc.consumer.scope_change'
  | 'mc.consumer.refresh_failed'
  | 'mc.consumer.url_change'
  | 'mc.consumer.capabilities_available'
  | 'mc.consumer.revoke';

export async function mcLinkAudit(
  sql: Sql,
  entry: { action: McLinkAuditAction; userId: string; linkId: string | null; payload: Record<string, unknown> },
): Promise<void> {
  await sql`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id, payload)
            values (null, ${entry.userId}, ${entry.action}, 'mc_link', ${entry.linkId}, ${JSON.stringify(entry.payload)}::text::jsonb)`;
}

/**
 * Refresh a link's tokens one refresher at a time (the pull, a wantlist
 * decision): a rotating refresh token spent twice looks like theft to the
 * issuer, which then kills the whole token family. Holds the link's row
 * (for update) while it refreshes, and only while the link is still active
 * at `remoteUrl`:
 *
 *   - the sealed tokens are no longer the ones the caller holds: another
 *     refresher was first, so its newer pair comes back and nothing is spent;
 *   - otherwise `exchange` spends the refresh token (a network call) and the
 *     new pair is saved with a compare-and-swap on the old one.
 *
 * Null when the link is gone, revoked or moved. `exchange` throwing rolls
 * back and passes the error on.
 */
export async function refreshLinkTokensLocked(
  sql: postgres.Sql<any>,
  link: { id: string; remoteUrl: string },
  heldSealed: string,
  exchange: () => Promise<string>,
): Promise<{ sealed: string; refreshed: boolean } | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx<Array<{ sealed_tokens: string }>>`
      select sealed_tokens from mc_links where id = ${link.id} and state = 'active' and remote_url = ${link.remoteUrl} for update`;
    if (!row) return null;
    if (row.sealed_tokens !== heldSealed) return { sealed: row.sealed_tokens, refreshed: false };
    const next = await exchange();
    const saved = await tx`update mc_links set sealed_tokens = ${next}, updated_at = now()
                            where id = ${link.id} and sealed_tokens = ${heldSealed} returning id`;
    return saved.length > 0 ? { sealed: next, refreshed: true } : null;
  }) as Promise<{ sealed: string; refreshed: boolean } | null>;
}
