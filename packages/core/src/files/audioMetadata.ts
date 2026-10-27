/**
 * The audio handler's metadata helpers: the tag snapshot stored in
 * files.tags_raw and the Tier 2 identity digest stored in
 * files.core_tags_digest. Moved here from the worker (lib/tagSnapshot.ts,
 * lib/helpers.ts) unchanged, so stored digests stay valid.
 */
import { createHash } from 'node:crypto';
import type { IAudioMetadata } from 'music-metadata';

/**
 * files.tags_raw for audio: music-metadata's common block plus the native frames
 * per tag type, pictures stripped. scan.parse and tags.apply both store this
 * shape; everything that reads tags_raw (identify, preview, lint) expects
 * `common` under this key, so a writer that stores the bare common block
 * makes every later reader see an untagged file.
 */
export function tagSnapshotOf(meta: IAudioMetadata): { common: Record<string, unknown>; native: Record<string, { id: string; value: unknown }[]> } {
  const common = safeJson({ ...meta.common }) as Record<string, unknown>;
  delete common['picture'];
  const native: Record<string, { id: string; value: unknown }[]> = {};
  for (const [tagType, frames] of Object.entries(meta.native)) {
    native[noNul(tagType)!] = frames
      .filter((f) => !/^APIC|PIC|covr|METADATA_BLOCK_PICTURE$/i.test(f.id))
      .map((f) => ({ id: noNul(f.id)!, value: safeJson(f.value) }));
  }
  return { common, native };
}

/**
 * Postgres text and jsonb cannot hold \u0000; old rips and broken headers
 * carry them. Use on every free-text value scan.parse stores.
 */
export function noNul(v: string | null | undefined): string | null {
  return v == null ? null : v.replaceAll('\u0000', '');
}

/** jsonb-safe conversion for native frame values (Buffers → summaries). */
function safeJson(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'string') return noNul(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `<binary ${v.length}B>`;
  if (Array.isArray(v)) return v.map(safeJson);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[noNul(k)!] = safeJson(val);
    return out;
  }
  return String(v);
}

const CORE_TEXT_FIELDS = ['artist', 'albumartist', 'album', 'title'] as const;
const CORE_MBID_FIELDS = [
  'musicbrainz_recordingid', 'musicbrainz_trackid', 'musicbrainz_albumid',
  'musicbrainz_releasegroupid', 'musicbrainz_albumartistid', 'musicbrainz_artistid',
] as const;

function coreScalar(v: unknown): string {
  if (typeof v === 'string') return v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return String(v);
  return '';
}

/** Multi-value tags are sorted after normalizing, so tag order from another
 * library version or a rewrite does not change the digest. */
function coreText(v: unknown): string {
  return Array.isArray(v) ? v.map(coreScalar).sort().join('\u0001') : coreScalar(v);
}

const YEAR4 = /(?<!\d)([12]\d{3})(?!\d)/;

/** One year rule for `year` and `date`, so both spellings give one digest: a 4-digit year 1000-2999. */
function yearOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1000 && v <= 2999 ? v : null;
  if (typeof v !== 'string') return null;
  const m = YEAR4.exec(v);
  return m ? Number(m[1]) : null;
}

/**
 * Tier 2's tag signature (move-safe scanning §1, R13): a hash of the fields a
 * move never changes, normalized so a tag-library upgrade (spacing, case,
 * Unicode form, a full date instead of a year) does not hide a pair. Null for
 * a file with none of them: untagged files would all look alike. The `v: 1`
 * in the hashed object is the format: change the fields or their rules and it
 * must change too, with core_tags_digest nulled so files.backfillDigest refills it.
 */
export function coreTagsDigest(tagsRaw: unknown): string | null {
  const common = (tagsRaw as { common?: Record<string, unknown> } | null)?.common;
  if (!common || typeof common !== 'object') return null;
  const no = (k: string): number | null => {
    const v = (common[k] as { no?: unknown } | undefined)?.no;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const year = yearOf(common['year']) ?? yearOf(common['date']);
  const text = Object.fromEntries(CORE_TEXT_FIELDS.map((k) => [k, coreText(common[k])]));
  const mbids = Object.fromEntries(CORE_MBID_FIELDS.map((k) => [k, coreText(common[k])]));
  const track = no('track');
  const disc = no('disk');
  const any = Object.values(text).some(Boolean) || Object.values(mbids).some(Boolean) || track !== null;
  if (!any) return null;
  return createHash('sha1').update(stableStringify({ v: 1, ...text, ...mbids, track, disc, year })).digest('hex');
}

/** JSON with object keys sorted at every level: equal values give equal text. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}
