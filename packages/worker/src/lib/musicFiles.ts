/**
 * Which files the music app groups into albums (cluster.dir): those whose
 * file-type handler it claims (@tagave/core/files; today 'audio'). Every
 * sender of cluster.dir that starts from file rows checks this first: scan.parse,
 * missing-marking (scan.root, scan.dir), the old and new folders of a merge
 * (Tier 1 in finishWalk, Tier 2 in a hold release), the hold releases and the
 * sweep. Albums the owner acts on (tag plans, merges, repairs, the album page's
 * "Rescan this folder") are music's own requests and are not gated here.
 */
import { handlerIdsOf } from '@tagave/core/files';

/** Handler ids the music app claims. */
export const MUSIC_HANDLERS: readonly string[] = handlerIdsOf('music');
const claimed = new Set(MUSIC_HANDLERS);

/** True when cluster.dir groups files of this handler. */
export function clusteredByMusic(handler: string | null | undefined): boolean {
  return handler != null && claimed.has(handler);
}
