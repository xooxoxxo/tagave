/**
 * Which app a file belongs to, for the scan pipeline (platform step 3): what
 * a library's walk indexes, and which grouping job a file's folder is sent
 * to when the file is parsed, goes missing, moves or comes out of a hold.
 *
 *   walkedHandlers(ctx, libraryId)   the handlers the library's app claims, while that app is on
 *   groupingQueue(handler)           the gate: the grouping queue of the app that claims the
 *                                    handler (audio → cluster.dir, epub/pdf/cbz → books.group);
 *                                    null for a handler no app claims
 *   sendGrouping(ctx, dir, opts)     one debounced send of that queue for one folder
 *
 * It replaces music's own gate (clusteredByMusic): every sender that starts
 * from file rows asks groupingQueue per row and sends that queue, so a books
 * folder never reaches cluster.dir and a music folder's sends are exactly
 * what they were (same queue, same singleton key, same delays).
 */
import { MUSIC_APP } from '@tagave/core/facets';
import { claimedHandlerIds, groupingQueueOf, libraryHandlerIds } from '@tagave/core/files';
import { enabledAppIds, libraryApp } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { clusterSingletonKey } from './helpers.js';

/** The grouping queue of a file's app, by its handler; null when no app groups it. */
export function groupingQueue(handler: string | null | undefined): string | null {
  return groupingQueueOf(handler);
}

/** A folder to send to an app's grouping job. */
export interface GroupDir {
  libraryId: string;
  scanRootId: string;
  dirPath: string;
  queue: string;
}

/** The singleton key of a grouping send: music's (scope-aware, sibling disc folders share one) for cluster.dir. */
export function groupingSingletonKey(queue: string, scanRootId: string, dirPath: string): string {
  return queue === MUSIC_APP.grouping?.queue ? clusterSingletonKey(scanRootId, dirPath) : `${queue}:${scanRootId}:${dirPath}`;
}

/** Sends the folder's grouping job, keyed per folder (the options are the caller's: the parser's debounce, a release's none). */
export async function sendGrouping(
  ctx: Pick<WorkerContext, 'boss'>, d: GroupDir, opts: { singletonSeconds?: number; startAfter?: number } = {},
): Promise<void> {
  await ctx.boss.send(d.queue, { libraryId: d.libraryId, scanRootId: d.scanRootId, dirPath: d.dirPath },
    { singletonKey: groupingSingletonKey(d.queue, d.scanRootId, d.dirPath), ...opts });
}

/**
 * The handlers a walk indexes. With a library: those its app claims while
 * the app is on (a built-in app always is): a music library walks audio, a
 * books library epub, pdf and cbz, and an app that is off walks nothing.
 * Without one (tests): every app that is on. Read once per walk; a row of a
 * handler the walk does not index is left as it is (neither seen nor
 * missing): turning an app off loses its function, never its data.
 */
export async function walkedHandlers(ctx: Pick<WorkerContext, 'sql'>, libraryId?: string): Promise<ReadonlySet<string>> {
  // On a database from before the module ledger (0065), or before
  // libraries.app (0068), which this worker runs on only with
  // TAGAVE_ALLOW_SCHEMA_SKEW, no app reads as on and every library as music:
  // the built-in apps' handlers are walked, as before.
  const on = new Set(await enabledAppIds(ctx.sql));
  const appOn = (app: string) => on.has(app);
  if (libraryId === undefined) return claimedHandlerIds(appOn);
  return libraryHandlerIds(await libraryApp(ctx.sql, libraryId), appOn);
}
