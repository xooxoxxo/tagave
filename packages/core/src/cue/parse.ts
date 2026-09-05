/**
 * CUE sheet parsing module
 * Handles decoding (UTF-8, UTF-16, cp1252) and format parsing
 * spec XO-314
 */

export interface CueTrack {
  number: number;
  title?: string;
  performer?: string;
  isrc?: string;
  flags?: string[];
  pregapMs?: number;
  indexes: Record<number, number>; // index no → ms
  startMs: number; // INDEX 01, else INDEX 00, else 0
}

export interface CueFile {
  path: string;
  type: string;
  tracks: CueTrack[];
}

export interface CueSheet {
  title?: string;
  performer?: string;
  songwriter?: string;
  catalog?: string;
  date?: number;
  genre?: string;
  discNumber?: number;
  totalDiscs?: number;
  comment?: string;
  encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'windows-1252';
  files: CueFile[];
}

/**
 * Decode CUE bytes with proper encoding detection.
 * Order: BOM (UTF-8 / UTF-16LE / UTF-16BE) → strict UTF-8 → windows-1252 fallback.
 * spec XO-314 archive facts
 */
export function decodeCueBytes(
  bytes: Uint8Array
): { text: string; encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'windows-1252' } {
  // Check for BOMs
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    // UTF-8 BOM
    const text = new TextDecoder('utf-8').decode(bytes.slice(3));
    return { text, encoding: 'utf-8-bom' };
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    // UTF-16LE BOM
    const text = new TextDecoder('utf-16le').decode(bytes.slice(2));
    return { text, encoding: 'utf-16le' };
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE BOM
    const text = new TextDecoder('utf-16be').decode(bytes.slice(2));
    return { text, encoding: 'utf-16be' };
  }

  // Try strict UTF-8
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, encoding: 'utf-8' };
  } catch {
    // Fall back to windows-1252
    const text = new TextDecoder('windows-1252').decode(bytes);
    return { text, encoding: 'windows-1252' };
  }
}

/**
 * Convert mm:ss:ff to milliseconds.
 * ff is frames at 75 frames/second.
 * spec XO-314 cue timing
 */
function frameTimeToMs(mm: number, ss: number, ff: number): number {
  return (mm * 60 + ss) * 1000 + Math.round((ff * 1000) / 75);
}

/**
 * Parse a CUE time string "mm:ss:ff" to milliseconds.
 */
function parseTime(timeStr: string | undefined): number | null {
  if (!timeStr) return null;
  const match = timeStr.match(/^(\d+):(\d+):(\d+)$/);
  if (!match?.[1] || !match?.[2] || !match?.[3]) return null;
  const mm = parseInt(match[1], 10);
  const ss = parseInt(match[2], 10);
  const ff = parseInt(match[3], 10);
  return frameTimeToMs(mm, ss, ff);
}

/**
 * Extract a quoted or unquoted value from the end of a line.
 * Everything before the last token is the value.
 * spec XO-314 design
 */
function extractValue(line: string): string {
  const trimmed = line.trim();

  // Check for quoted value: COMMAND "value" or COMMAND "value" TYPE
  const quotedMatch = trimmed.match(/^(\S+)\s+"([^"]*)"\s*(?:\S+\s*)?$/);
  if (quotedMatch?.[2]) {
    return quotedMatch[2];
  }

  // Unquoted: everything from first token + space to second-to-last token
  // E.g., "FILE x with spaces.wav WAVE" → value is "x with spaces.wav"
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) return '';

  // Remove the first token (command like FILE, REM, etc.)
  // Everything from space after first token to the last token is the value
  const firstToken = tokens[0];
  const lastToken = tokens[tokens.length - 1];
  if (!firstToken || !lastToken) return '';

  const firstTokenLen = firstToken.length;
  const lastTokenLen = lastToken.length;

  const beforeLastToken = trimmed.substring(0, trimmed.length - lastTokenLen).trimEnd();
  const afterFirstToken = beforeLastToken.substring(firstTokenLen).trim();

  return afterFirstToken;
}

/**
 * Parse a CUE sheet from text (already decoded).
 * Tolerates CRLF, BOM (already handled), tabs, trailing garbage, junk lines.
 * Never throws.
 */
export function parseCueSheet(input: Uint8Array | string): CueSheet {
  let text: string;
  let encoding: CueSheet['encoding'] = 'utf-8';

  if (input instanceof Uint8Array) {
    const decoded = decodeCueBytes(input);
    text = decoded.text;
    encoding = decoded.encoding;
  } else {
    text = input;
  }

  const lines = text.split(/\r?\n/);
  const sheet: CueSheet = {
    encoding,
    files: [],
  };

  let currentFile: CueFile | null = null;
  let currentTrack: CueTrack | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith(';')) continue;

    const tokens = trimmed.split(/\s+/);
    const command = tokens[0]?.toUpperCase();

    if (!command) continue;

    if (command === 'TITLE') {
      const value = extractValue(trimmed);
      if (currentTrack) {
        currentTrack.title = value;
      } else if (currentFile) {
        // File-level title (not standard, but tolerate)
      } else {
        sheet.title = value;
      }
    } else if (command === 'PERFORMER') {
      const value = extractValue(trimmed);
      if (currentTrack) {
        currentTrack.performer = value;
      } else if (currentFile) {
        // File-level performer (not standard, but tolerate)
      } else {
        sheet.performer = value;
      }
    } else if (command === 'SONGWRITER') {
      const value = extractValue(trimmed);
      if (!currentTrack && !currentFile) {
        sheet.songwriter = value;
      }
    } else if (command === 'CATALOG') {
      const value = extractValue(trimmed);
      if (!currentTrack && !currentFile) {
        sheet.catalog = value;
      }
    } else if (command === 'REM') {
      // REM lines: REM KEY value
      const remMatch = trimmed.match(/^REM\s+(\S+)\s*(.*)/i);
      if (remMatch?.[1]) {
        const key = remMatch[1];
        const value = remMatch[2] ?? '';
        const keyUpper = key.toUpperCase();

        if (keyUpper === 'DATE' && !currentTrack && !currentFile) {
          const year = parseInt(value, 10);
          if (!isNaN(year)) {
            sheet.date = year;
          }
        } else if (keyUpper === 'GENRE' && !currentTrack && !currentFile) {
          // Remove quotes if present
          sheet.genre = value.replace(/^"(.*)"$/, '$1');
        } else if (keyUpper === 'DISCNUMBER' && !currentTrack && !currentFile) {
          const num = parseInt(value, 10);
          if (!isNaN(num)) {
            sheet.discNumber = num;
          }
        } else if (keyUpper === 'TOTALDISCS' && !currentTrack && !currentFile) {
          const num = parseInt(value, 10);
          if (!isNaN(num)) {
            sheet.totalDiscs = num;
          }
        } else if (keyUpper === 'COMMENT' && !currentTrack && !currentFile) {
          sheet.comment = value.replace(/^"(.*)"$/, '$1');
        }
      }
    } else if (command === 'FILE') {
      // Finalize current track
      if (currentTrack) {
        if (currentFile) {
          currentFile.tracks.push(currentTrack);
        }
        currentTrack = null;
      }

      // Finalize current file
      if (currentFile) {
        sheet.files.push(currentFile);
      }

      const value = extractValue(trimmed);
      const lastToken = tokens[tokens.length - 1];
      const fileType = lastToken ?? '';

      currentFile = {
        path: value,
        type: fileType,
        tracks: [],
      };
    } else if (command === 'TRACK') {
      // Finalize current track
      if (currentTrack) {
        if (currentFile) {
          currentFile.tracks.push(currentTrack);
        }
      }

      const trackNumStr = tokens[1];
      const trackNum = trackNumStr ? parseInt(trackNumStr, 10) : 0;
      const trackType = (tokens[2]?.toUpperCase() ?? 'AUDIO');

      // Skip non-AUDIO tracks
      if (trackType !== 'AUDIO') {
        currentTrack = null;
      } else {
        currentTrack = {
          number: trackNum,
          indexes: {},
          startMs: 0,
        };
      }
    } else if (command === 'INDEX' && currentTrack) {
      const indexNumStr = tokens[1];
      const timeStr = tokens[2];
      const indexNum = indexNumStr ? parseInt(indexNumStr, 10) : NaN;

      if (!isNaN(indexNum) && timeStr) {
        const ms = parseTime(timeStr);
        if (ms !== null) {
          currentTrack.indexes[indexNum] = ms;

          // Set startMs to INDEX 01, else INDEX 00, else 0
          // spec XO-314: tolerate INDEX order (01 may appear before 00)
          if (indexNum === 1) {
            currentTrack.startMs = ms;
          } else if (indexNum === 0 && currentTrack.indexes[1] === undefined) {
            // INDEX 00 sets startMs only if INDEX 01 hasn't been seen yet
            currentTrack.pregapMs = ms;
            currentTrack.startMs = ms;
          } else if (indexNum === 0) {
            // INDEX 00 after INDEX 01: just set pregapMs
            currentTrack.pregapMs = ms;
          }
        }
      }
    } else if (command === 'FLAGS' && currentTrack) {
      // FLAGS are space-separated on the rest of the line
      currentTrack.flags = tokens.slice(1).filter((t): t is string => !!t);
    } else if (command === 'ISRC' && currentTrack) {
      const value = extractValue(trimmed);
      currentTrack.isrc = value;
    }
  }

  // Finalize remaining track and file
  if (currentTrack && currentFile) {
    currentFile.tracks.push(currentTrack);
  }
  if (currentFile) {
    sheet.files.push(currentFile);
  }

  return sheet;
}
