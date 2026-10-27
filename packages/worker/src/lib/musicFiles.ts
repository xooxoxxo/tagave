/**
 * Which files the music app groups into albums (cluster.dir): those whose
 * file-type handler its manifest claims (MUSIC_APP.fileTypes in
 * @tagave/core/facets, manifest v2; today 'audio'). Every sender of
 * cluster.dir that starts from file rows checks this first: scan.parse,
 * missing-marking (scan.root, scan.dir), the old and new folders of a merge
 * (Tier 1 in finishWalk, Tier 2 in a hold release), the hold releases and the
 * sweep; so do the readers that pick an album's or a folder's files
 * (cluster.dir's candidates, a tag plan's library and folder scopes, the
 * folder tag editor). Albums the owner acts on (tag plans, merges, repairs,
 * the album page's "Rescan this folder") are music's own requests and are
 * not gated here.
 *
 * What the walk indexes at all is wider: the handlers of every app that is
 * on (walkedHandlers).
 */
import { MUSIC_APP } from '@tagave/core/facets';
import { claimedHandlerIds, handlerIdsOf } from '@tagave/core/files';
import { enabledAppIds } from '@tagave/db';
import type { WorkerContext } from './context.js';

/** Handler ids the music app claims, from its manifest. */
export const MUSIC_HANDLERS: readonly string[] = handlerIdsOf(MUSIC_APP.id);
const claimed = new Set(MUSIC_HANDLERS);

/** True when cluster.dir groups files of this handler. */
export function clusteredByMusic(handler: string | null | undefined): boolean {
  return handler != null && claimed.has(handler);
}

/**
 * The handlers the walk indexes: those claimed by an app that is on in the
 * module ledger (installed_modules), and by a built-in app always (music).
 * Read once per walk. A file of a handler no app that is on claims is not
 * indexed, and a row of one already indexed is left as it is (neither seen
 * nor missing): turning an app off loses its function, never its data.
 */
export async function walkedHandlers(ctx: Pick<WorkerContext, 'sql'>): Promise<ReadonlySet<string>> {
  const on = new Set(await enabledAppIds(ctx.sql));
  return claimedHandlerIds((app) => on.has(app));
}
