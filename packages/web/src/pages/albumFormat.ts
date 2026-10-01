import type { DetailTrack } from './albumDetailTypes';

export function dur(ms: number | null | undefined): string {
  if (!ms) return '–:––';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "1 hr 12 min" / "38 min" for the album's total length. */
export function totalLength(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} hr ${min % 60} min`;
}

export function mb(bytes: number | null): string {
  return bytes ? `${(bytes / 1048576).toFixed(1)} MB` : '';
}

/** "FLAC · 24bit/96.0kHz · 41.2 MB" */
export function fileLine(t: DetailTrack): string {
  return [
    t.file.codec,
    t.file.lossless
      ? `${t.file.bitDepth ?? '?'}bit/${((t.file.sampleRate ?? 0) / 1000).toFixed(1)}kHz`
      : t.file.bitrateKbps
        ? `${t.file.bitrateKbps}kbps`
        : null,
    mb(t.file.sizeBytes),
  ].filter(Boolean).join(' · ');
}

export const STATE_LABEL: Record<string, string> = {
  matched: 'Matched',
  needs_review: 'Needs review',
  pending: 'Awaiting identification',
  unidentified: 'Unidentified',
  as_is: 'Kept as-is',
  ignored: 'Ignored',
};

/**
 * The track's own artist, when it is not the album's (a compilation, a
 * guest). The album's artist can arrive as several spellings — the local
 * credit, the release credit, the linked artists — and a track tag often
 * joins the same names differently ("A + B" for "A, B"), so all count.
 */
export function trackArtistIfDifferent(trackArtist: string | null | undefined, albumArtists: ReadonlyArray<string | null | undefined>, names: readonly string[] = []): string | null {
  const t = trackArtist?.trim();
  if (!t) return null;
  const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const nt = norm(t);
  if (albumArtists.some((a) => a && norm(a) === nt)) return null;
  // every linked artist named, and nothing much else: joiners only
  const ns = names.map(norm).filter(Boolean);
  if (ns.length > 0 && ns.every((n) => nt.includes(n))) {
    let rest = nt;
    for (const n of ns) rest = rest.replace(n, '');
    if (/^[\s,&+/;.-]*(and|with|feat\.?|ft\.?)?[\s,&+/;.-]*$/.test(rest)) return null;
  }
  return t;
}

/** How often the album page looks again while a cover-art lookup is queued or running: quickly only while the owner is watching for it. */
export function artPollMs(asked: boolean, maintenance: boolean): number {
  return asked || maintenance ? 2500 : 10000;
}
