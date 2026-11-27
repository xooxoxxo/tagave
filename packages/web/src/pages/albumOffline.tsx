/**
 * An album whose files sit on a music folder tagave can't reach (the API's
 * `filesOffline`, `offlineSince`; availability's reason 'offline'): the
 * line under the album's facts with its help behind "?" (for everyone), and
 * the words Play waits with (the player module's, so only with a player).
 */
import type { AlbumSummary, PlayerAlbumAvailability, PlayerScanStatus } from '@tagave/shared';
import { HelpToggle } from '../components/ui/HelpToggle';
import { scanWaitLine } from '../player/logic';
import { sinceLabel } from '../utils/time';
import styles from './albumOffline.module.css';

export interface OfflineLine { text: string; help: string }

const HELP_ALL = 'The music folder with these files can\'t be reached. You can still browse, edit and plan. tagave writes your changes when it\'s back.';
const HELP_SOME = 'Some of this album\'s files are in a music folder tagave can\'t reach.';

/** "Files offline since 14:02" or "Some files offline", with its help; null while every folder is online. */
export function offlineLine(a: { filesOffline?: AlbumSummary['filesOffline']; offlineSince?: AlbumSummary['offlineSince'] }, now: Date = new Date()): OfflineLine | null {
  if (a.filesOffline === 'all') return { text: a.offlineSince ? `Files offline since ${sinceLabel(a.offlineSince, now)}` : 'Files offline', help: HELP_ALL };
  if (a.filesOffline === 'some') return { text: 'Some files offline', help: HELP_SOME };
  return null;
}

/** The line: its words, and the help behind "?". */
export function AlbumOfflineLine({ line, className }: { line: OfflineLine; className?: string | undefined }) {
  return (
    <div className={[styles.line, className].filter(Boolean).join(' ')} data-album-offline="">
      <span className={styles.text}>{line.text}</span>
      <HelpToggle label={line.text}>{line.help}</HelpToggle>
    </div>
  );
}

export const PLAY_OFFLINE_NOTE = 'Can\'t play: the files are offline';

/**
 * Play's quiet note and whether Play (and Shuffle with it) waits: the player
 * is not answering, its scan has not reached the album, the files are
 * missing, inside a CUE image, or offline. An album the player has simply
 * not seen keeps Play: pressing it asks the player to look for the files.
 * Without a player there is no note (the row is not there either).
 */
export function albumPlayWait({ playerInstalled, canPlay, availability: avail, scan, filesOffline }: {
  playerInstalled: boolean;
  canPlay: boolean;
  availability: PlayerAlbumAvailability | null | undefined;
  scan: PlayerScanStatus | null | undefined;
  filesOffline: AlbumSummary['filesOffline'] | undefined;
}): { note: string | null; disabled: boolean } {
  const offline = filesOffline === 'all' || (!!avail && avail.playable === 0 && avail.reason === 'offline');
  const note: string | null = !playerInstalled ? null
    : !canPlay ? 'The player is not answering right now'
      : offline ? PLAY_OFFLINE_NOTE
        : avail && avail.playable === 0
          ? scanWaitLine(scan)
            ?? (avail.reason === 'no_file' ? 'The files are missing or could not be read'
              : avail.reason === 'cue' ? 'Tracks inside a CUE image cannot be played yet'
                : avail.reason === 'not_scanned' ? 'Not on the player yet' : null)
          : null;
  const disabled = !canPlay || offline || (!!avail && avail.playable === 0 && (!!scan?.scanning || avail.reason === 'no_file' || avail.reason === 'cue'));
  return { note, disabled };
}

/** Rescan folder stays while the files are offline; it says it waits. */
export function rescanHint(filesOffline: AlbumSummary['filesOffline'] | undefined): string | undefined {
  return filesOffline ? 'Waits for the music folder' : undefined;
}
