/**
 * The Jev request for one album: every tracklist group in one shared state,
 * one yes/no question per group. Built only from matching evidence, so it
 * holds album metadata from tags and public provider data, nothing else:
 * titles and years that did not come from tags are placeholders, and no
 * path, file name, folder name, release id, provider key or account is in
 * it. An album whose own title did not come from its tags is not sent at
 * all (there is no placeholder for an album title). The owner is shown
 * exactly this.
 *
 * Every object is built field by field in a fixed order, and groups and
 * their members are put in a fixed order, so the same evidence and groups
 * always give the same JSON text.
 */
import type { AlbumEvidence, CandidateEvidence } from '../matching/evidence.js';
import type { GroupingCandidate, TracklistGroup } from './grouping.js';
import { JEV_SPEC, type JevSpec } from './jevSpec.js';

export interface JevLocalTrack { n: number; disc?: number; title: string; length: string | null }
export interface JevEdition { source: 'MusicBrainz' | 'Discogs'; title: string; artist: string; year: number | null; country: string | null; label: string | null; catalogue: string | null; format: string | null; discs: number | null; status: string | null }
export interface JevTracklist { editions: JevEdition[]; tracks: Array<{ n: number; disc?: number; title: string; length: string | null }>; pairing: { pairs: Array<[local: number, remote: number]>; localUnpaired: number[]; remoteUnpaired: number[] } }
export interface JevState { task: string; local: { artist: string; album: string; year: number | 'year unknown'; discs: number | null; tracks: JevLocalTrack[] }; tracklists: Record<string, JevTracklist> }
export interface JevQuestion { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
export interface JevRequest { model: string; state: JevState; questions: Record<string, JevQuestion> }

/** The album cannot be sent without a value that did not come from its tags. */
export class NotSendableError extends Error {
  readonly reason: 'album_title' | 'capped';
  constructor(reason: 'album_title' | 'capped') {
    super(`album not sendable: ${reason === 'album_title' ? 'its title did not come from its tags' : 'a tracklist is over the alignment cap, so no pairing exists to send'}`);
    this.name = 'NotSendableError';
    this.reason = reason;
  }
}

/** Seconds as m:ss; null for unknown. */
function length(s: number | null): string | null {
  if (s === null || !Number.isFinite(s) || s < 0) return null;
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export const questionName = (label: string): string => `is_${label}`;

/** A 0-based index into a list of `count`, as a 1-based number; throws when outside it. */
function oneBased(i: number, count: number, what: string): number {
  if (!(Number.isInteger(i) && i >= 0 && i < count)) throw new RangeError(`jev request: ${what} index ${i} outside 0..${count - 1}`);
  return i + 1;
}

/** Labels in group order: A..Z, then AA, AB, ... (shorter first, then by letter). */
const byLabel = (a: TracklistGroup, b: TracklistGroup): number =>
  a.label.length - b.label.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

/** Anchor first, then by distance; ties by release id, which is used for order only and never sent. */
function orderedMembers(g: TracklistGroup): GroupingCandidate[] {
  const rest = g.members.filter((m) => m.releaseId !== g.anchor.releaseId);
  rest.sort((a, b) => a.distance - b.distance || (a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0));
  return [g.anchor, ...rest];
}

function edition(ev: CandidateEvidence): JevEdition {
  const r = ev.remote;
  return {
    source: r.provider === 'discogs' ? 'Discogs' : 'MusicBrainz',
    title: r.title,
    artist: r.artists.join(', '),
    year: r.year,
    country: r.country,
    label: r.label,
    catalogue: r.catalogNumber,
    format: r.media,
    discs: r.mediumCount,
    status: r.status,
  };
}

function tracklist(g: TracklistGroup, localCount: number): JevTracklist {
  const a = g.anchor.evidence;
  const remoteCount = a.tracks.length;
  const multiDisc = (a.remote.mediumCount ?? 1) > 1;
  return {
    editions: orderedMembers(g).map((m) => edition(m.evidence)),
    tracks: a.tracks.map(([medium, title, durS], i) => ({
      n: i + 1,
      ...(medium !== null && multiDisc ? { disc: medium } : {}),
      title,
      length: length(durS),
    })),
    pairing: {
      pairs: a.align.map(([l, r]): [number, number] => [oneBased(l, localCount, 'paired local track'), oneBased(r, remoteCount, 'paired remote track')]),
      localUnpaired: a.unmatchedLocal.map((i) => oneBased(i, localCount, 'unpaired local track')),
      remoteUnpaired: a.missingRemote.map((i) => oneBased(i, remoteCount, 'unpaired remote track')),
    },
  };
}

/**
 * Throws NotSendableError when the album title did not come from its tags,
 * and a RangeError when a pairing index is outside its tracklist or two
 * groups share a label.
 */
export function buildJevRequest(album: AlbumEvidence, groups: TracklistGroup[], model: string, spec: JevSpec = JEV_SPEC): JevRequest {
  if (album.titleSource !== 'tag') throw new NotSendableError('album_title');
  // over the cap the scorer aligned nothing: "all unpaired" would read as "nothing matches"
  if (groups.some((g) => g.members.some((m) => m.evidence.capped))) throw new NotSendableError('capped');
  const localCount = album.tracks.length;
  const tracks: JevLocalTrack[] = album.tracks.map((t, i) => ({
    n: i + 1,
    ...(album.discsKnown && t.disc !== null ? { disc: t.disc } : {}),
    title: t.titleSource === 'tag' ? t.title : spec.placeholders.title.replace('{n}', String(i + 1)),
    length: length(t.durS),
  }));
  const local: JevState['local'] = {
    artist: album.artist,
    album: album.title,
    year: album.year !== null && album.yearSource === 'tag' ? album.year : spec.placeholders.year,
    discs: album.discsKnown ? album.discCount : null,
    tracks,
  };

  const ordered = [...groups].sort(byLabel);
  const tracklists: Record<string, JevTracklist> = {};
  const questions: Record<string, JevQuestion> = {};
  for (const g of ordered) {
    if (g.label === '' || Object.prototype.hasOwnProperty.call(tracklists, g.label)) {
      throw new RangeError(`jev request: group label ${JSON.stringify(g.label)} is empty or used twice`);
    }
    tracklists[g.label] = tracklist(g, localCount);
    questions[questionName(g.label)] = {
      type: 'noul',
      instructions: spec.instructions.replaceAll('{label}', g.label),
      criteria: { true: spec.criteria.true, false: spec.criteria.false },
    };
  }
  return { model, state: { task: spec.task, local, tracklists }, questions };
}

/** UTF-8 bytes of JSON.stringify(req), the size the service sees. */
export function requestBytes(req: JevRequest): number {
  return new TextEncoder().encode(JSON.stringify(req)).length;
}
