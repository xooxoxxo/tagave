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
            values (null, ${entry.userId}, ${entry.action}, 'mc_link', ${entry.linkId}, ${sql.json(entry.payload as never)})`;
}
