/**
 * The music bind's keys in .env. compose.yml binds the music with
 * `read_only: ${TAGAVE_MUSIC_READ_ONLY:-true}`, but installs from before
 * 0.38.0 only have TAGAVE_MUSIC_MODE (rw or ro). The updater's config step
 * and install-tagave.sh's write_env derive TAGAVE_MUSIC_READ_ONLY from it
 * before compose runs, so an rw install keeps writing its tags.
 *
 * Only keys whose value must change come back: an old ro .env gives {}, and
 * a second run is a no-op. The parent layout keys (TAGAVE_MUSIC_BIND_SOURCE
 * and the rest) are never written here.
 */
import { envGet } from './envFile.js';

export function musicBindKeys(envText: string): Record<string, string> {
  const writable = envGet(envText, 'TAGAVE_MUSIC_MODE') === 'rw';
  const readOnly = envGet(envText, 'TAGAVE_MUSIC_READ_ONLY');
  if (writable && readOnly !== 'false') return { TAGAVE_MUSIC_READ_ONLY: 'false' };
  if (!writable && readOnly !== null && readOnly !== 'true') return { TAGAVE_MUSIC_READ_ONLY: 'true' };
  return {};
}
