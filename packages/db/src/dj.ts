/**
 * The dj module's switch and its data (Module Composition Principle rule 2).
 *
 *   turn off          dj.analyze skips, the /me/dj routes answer 404, the
 *                     player is exactly the player without it; rows stay
 *   delete its data   dj_track_analysis is emptied, nothing else
 *
 * The switch is the module ledger's row 'dj' (installed_modules), off until
 * the owner turns it on. Read per call. Its settings (crossfade and the
 * rest) live in that row's settings (moduleSettings).
 */
import type postgres from 'postgres';
import { moduleEnabled, setModuleEnabled } from './modules.js';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;

export const DJ_MODULE_ID = 'dj';

/** Every table the module owns. */
export const DJ_TABLES = ['dj_track_analysis'] as const;

export async function djEnabled(sql: Sql | Tx): Promise<boolean> {
  return moduleEnabled(sql, DJ_MODULE_ID);
}

export async function setDjEnabled(sql: Sql | Tx, enabled: boolean): Promise<void> {
  await setModuleEnabled(sql, DJ_MODULE_ID, enabled);
}

/** Delete the module's data: exactly its rows, in one transaction. Idempotent. */
export async function removeDjData(sql: Sql): Promise<Record<(typeof DJ_TABLES)[number], number>> {
  return sql.begin(async (tx) => {
    const out = {} as Record<(typeof DJ_TABLES)[number], number>;
    for (const t of DJ_TABLES) out[t] = (await tx`delete from ${tx(t)}`).count;
    return out;
  });
}

/** One track's analysis as stored (the worker writes it). */
export interface DjStoredAnalysis {
  audioHash: string;
  fileSizeBytes: number | null;
  fileMtime: number | null;
  durationMs: number;
  bpm: number | null;
  bpmConfidence: number | null;
  firstBeatMs: number | null;
  trimStartMs: number | null;
  trimEndMs: number | null;
  peaks: Uint8Array;
}

export async function saveDjAnalysis(sql: Sql | Tx, localTrackId: string, a: DjStoredAnalysis): Promise<void> {
  await sql`
    insert into dj_track_analysis (local_track_id, audio_hash, file_size_bytes, file_mtime, duration_ms, bpm, bpm_confidence,
                                   first_beat_ms, trim_start_ms, trim_end_ms, peaks, analyzed_at, error)
    values (${localTrackId}, ${a.audioHash}, ${a.fileSizeBytes}, ${a.fileMtime}, ${a.durationMs}, ${a.bpm}, ${a.bpmConfidence},
            ${a.firstBeatMs}, ${a.trimStartMs}, ${a.trimEndMs}, ${Buffer.from(a.peaks)}, now(), null)
    on conflict (local_track_id) do update set
      audio_hash = excluded.audio_hash, file_size_bytes = excluded.file_size_bytes, file_mtime = excluded.file_mtime,
      duration_ms = excluded.duration_ms, bpm = excluded.bpm, bpm_confidence = excluded.bpm_confidence,
      first_beat_ms = excluded.first_beat_ms, trim_start_ms = excluded.trim_start_ms, trim_end_ms = excluded.trim_end_ms,
      peaks = excluded.peaks, analyzed_at = now(), error = null`;
}

/** A failed analysis: the error, and the file as it was, so the sweep waits a week or for a change. */
export async function recordDjError(sql: Sql | Tx, localTrackId: string, error: string, file: { size: number | null; mtime: number | null }): Promise<void> {
  await sql`
    insert into dj_track_analysis (local_track_id, file_size_bytes, file_mtime, analyzed_at, error)
    values (${localTrackId}, ${file.size}, ${file.mtime}, now(), ${error.slice(0, 500)})
    on conflict (local_track_id) do update set
      file_size_bytes = excluded.file_size_bytes, file_mtime = excluded.file_mtime, analyzed_at = now(), error = excluded.error`;
}
