/**
 * The files the music app reads as its own: those whose file-type handler
 * its manifest claims (MUSIC_APP.fileTypes in @tagave/core/facets, manifest
 * v2; today 'audio'). The readers that pick an album's or a folder's files
 * use it (cluster.dir's candidates, a tag plan's library and folder scopes,
 * the loose-files backfill).
 *
 * Which grouping job a file's folder is sent to, and what a walk indexes,
 * are the app-generic appFiles.ts (groupingQueue, walkedHandlers).
 */
import { MUSIC_APP } from '@tagave/core/facets';
import { handlerIdsOf } from '@tagave/core/files';

/** Handler ids the music app claims, from its manifest. */
export const MUSIC_HANDLERS: readonly string[] = handlerIdsOf(MUSIC_APP.id);
