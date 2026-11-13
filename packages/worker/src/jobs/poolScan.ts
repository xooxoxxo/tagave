/**
 * pool.scan (0081, vault "tagave - Naming Rules and Drop Pool"): the drop
 * pool's watcher. Every two minutes (and when the owner turns the pool on or
 * acts on Inbox) it reads the pool folder, groups its songs into albums by
 * folder (a disc folder, "CD1", belongs to its album's), and for each album:
 *
 * wait      until its files have been still for two minutes: the same files,
 *           sizes and newest mtime as the last look, and nothing written in
 *           the last two minutes (a download in progress, a .part file);
 * identify  with identify's own search (MusicBrainz; AcoustID when the
 *           library fingerprints and has a key) and identify's own decision
 *           (decideAuto, then the owner's auto-accept rules when they are on);
 * import    a confident match whose release group the library does not hold:
 *           tagged with the canonical preset, moved to its rule path, scanned
 *           (files.move, kind import);
 * inbox     anything else: unsure, unidentified, or already in the library,
 *           for the owner in Library care › Inbox.
 *
 * The scanner never walks the pool, and the scan used no file watcher
 * (inotify does not cross the NFS share), so neither does this.
 *
 * It runs on the file worker (rides with tags.apply), and first checks the
 * music folder is really there (checkMusicFolder): a process without the
 * music mount reports "music folder unreachable" and makes nothing. What it
 * found (ready, unreachable, folder missing) is libraries.settings
 * .dropPoolStatus, the line on Settings › Library › Drop pool.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import {
  currentFieldsFrom, evaluateAutoAccept, rankAcoustIdReleases, scoreCandidates,
  type AcoustIdRecording, type CanonicalRelease, type ReleaseQuery,
} from '@tagave/core';
import { tagSnapshotOf } from '@tagave/core/files';
import {
  DROP_POOL_STABLE_SECONDS, matchPercent, moveConfidence,
  type DropPoolState, type PoolCandidate, type PoolFile, type PoolPairing, type PoolScanJobData,
} from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { exists, NDIGNORE } from '../lib/deletions.js';
import { discDirNumber } from '../lib/helpers.js';
import { dropPoolOf, dropPoolStatusOf, filesUnder, isAudioName, saveDropPoolStatus } from '../lib/naming.js';
import { checkMusicFolder, MUSIC_FOLDER_UNREACHABLE } from '../lib/musicFolder.js';
import { acoustidCall, getProviders, libraryProviderSettings } from '../lib/providers.js';
import { cached, cacheKey } from '../lib/providerCache.js';
import { fingerprintHash, fpcalcFingerprint } from '../lib/fingerprint.js';
import { localTrackViews, planTrackLinks } from '../lib/trackLinks.js';
import { loadRules } from '../lib/autoAccept.js';
import { decideAuto, fastPathOutcome, mbRelease, mbSearch, persistFetched, toScorable } from './identifyAlbum.js';
import { queueImport } from './poolImport.js';

/** A file still being written: a download client's part file. */
const PARTIAL = /\.(?:part|partial|crdownload|download|!qb|!ut|tmp|aria2|opdownload)$/i;
const MAX_LOOKUPS = 3;
/** identify's fingerprint rule (IDN-5): a release that explains this share with track parity. */
const ACOUSTID_ACCEPT_COVERAGE = 0.8;

export interface PoolDeps {
  /** MusicBrainz search and release fetch; default identify's (cached, paced) */
  search?: (q: ReleaseQuery) => Promise<Array<{ release: { id: string; tracks?: unknown[] } }>>;
  release?: (mbid: string) => Promise<CanonicalRelease>;
  now?: () => Date;
}

interface Group {
  dir: string;
  audio: Array<{ relPath: string; size: number; mtimeMs: number }>;
  count: number;
  bytes: number;
  newest: number;
  partial: boolean;
}

/** The pool's albums: each folder of songs, disc folders folded into their album's. */
export async function poolGroups(root: string, poolDir: string): Promise<Group[]> {
  const files = await filesUnder(root, poolDir);
  const groups = new Map<string, Group>();
  const albumOf = (rel: string) => {
    let d = path.posix.dirname(rel);
    if (d !== poolDir && discDirNumber(path.posix.basename(d)) !== null && path.posix.dirname(d) !== '.') d = path.posix.dirname(d);
    return d;
  };
  const stats = new Map<string, { size: number; mtimeMs: number }>();
  for (const f of files) {
    try {
      const s = await stat(path.join(root, f));
      stats.set(f, { size: s.size, mtimeMs: s.mtimeMs });
    } catch { /* gone meanwhile */ }
  }
  for (const f of files) {
    if (!isAudioName(path.posix.basename(f)) || !stats.has(f)) continue;
    const dir = albumOf(f);
    if (dir === poolDir) {
      // a song straight in the pool is an album of its own folder: the pool itself is never one
      continue;
    }
    const g = groups.get(dir) ?? { dir, audio: [], count: 0, bytes: 0, newest: 0, partial: false };
    g.audio.push({ relPath: f, ...stats.get(f)! });
    groups.set(dir, g);
  }
  // every file of the album's folder counts towards its stillness (a cover still arriving, a .part)
  for (const f of files) {
    const s = stats.get(f);
    const g = [...groups.values()].find((x) => f.startsWith(`${x.dir}/`));
    if (!g) continue;
    if (PARTIAL.test(f)) g.partial = true;
    if (!s) continue;
    g.count++;
    g.bytes += s.size;
    g.newest = Math.max(g.newest, s.mtimeMs);
  }
  return [...groups.values()];
}

const signatureOf = (g: Group) => `${g.count}:${g.bytes}:${Math.floor(g.newest / 1000)}${g.partial ? ':partial' : ''}`;

/** Still for the whole wait: nothing written for two minutes, and the same files as when it was last seen to change. */
export function isStill(g: Group, stableSince: Date, now: Date): boolean {
  if (g.partial) return false;
  const wait = DROP_POOL_STABLE_SECONDS * 1000;
  return now.getTime() - stableSince.getTime() >= wait && now.getTime() - g.newest >= wait;
}

interface Item { id: string; dirPath: string; state: string; signature: string | null; stableSince: Date | string | null }

/** pool.scan for one library (or every library with a pool on). */
export async function poolScanJob(ctx: WorkerContext, data: PoolScanJobData = {}, deps: PoolDeps = {}): Promise<Record<string, unknown>> {
  const libs = data.libraryId ? [data.libraryId] : ((await ctx.sql`
    select id::text as id from libraries where jsonb_typeof(settings) = 'object' and (settings->'dropPool'->>'enabled')::boolean is true`) as unknown as Array<{ id: string }>).map((r) => r.id);
  const out: Record<string, unknown> = {};
  for (const libraryId of libs) {
    try {
      out[libraryId] = await scanPool(ctx, libraryId, data, deps);
    } catch (err) {
      ctx.logger.warn({ libraryId, err: (err as Error).message }, 'pool.scan failed');
      out[libraryId] = { error: (err as Error).message };
    }
  }
  return out;
}

async function scanPool(ctx: WorkerContext, libraryId: string, data: PoolScanJobData, deps: PoolDeps): Promise<Record<string, unknown>> {
  const pool = await dropPoolOf(ctx, libraryId);
  if (!pool.enabled || !pool.scanRootId || !pool.dirPath) return { skipped: 'off' };
  const [root] = (await ctx.sql`select path, writable from scan_roots where id = ${pool.scanRootId} and library_id = ${libraryId}`) as unknown as Array<{ path: string; writable: boolean }>;
  if (!root) return { skipped: 'no music folder' };
  if (!root.writable) return { skipped: 'read-only' };
  const poolAbs = path.join(root.path, pool.dirPath);
  const prev = await dropPoolStatusOf(ctx, libraryId, pool.scanRootId, pool.dirPath);
  const report = async (state: DropPoolState, seenReady: boolean) => {
    if (prev?.state === state && prev.seenReady === seenReady) return;
    await saveDropPoolStatus(ctx, libraryId, { state, scanRootId: pool.scanRootId!, dirPath: pool.dirPath!, seenReady, at: (deps.now?.() ?? new Date()).toISOString() });
  };
  // nothing is made, read or forgotten unless this process sees the real music folder
  const reach = await checkMusicFolder(ctx, pool.scanRootId, root.path);
  if (!reach.reachable) {
    await report('unreachable', prev?.seenReady ?? false);
    return { skipped: MUSIC_FOLDER_UNREACHABLE };
  }
  // made when the owner turns the pool on, and until this folder was first seen
  // ready (an install whose pool was made on the wrong worker's disk): once
  // seen, a pool folder that goes is the owner's doing, and stays gone
  if ((data.create || !prev?.seenReady) && !(await exists(poolAbs))) {
    await mkdir(poolAbs, { recursive: true });
  }
  if (!(await exists(poolAbs))) {
    await report('missing', prev?.seenReady ?? false);
    return { skipped: 'no pool folder' };
  }
  await report('ready', true);
  // the player server's own scan leaves the pool alone too
  if (!(await exists(path.join(poolAbs, NDIGNORE)))) await writeFile(path.join(poolAbs, NDIGNORE), '').catch(() => undefined);

  const now = deps.now?.() ?? new Date();
  const groups = await poolGroups(root.path, pool.dirPath);
  const items = (await ctx.sql`
    select id::text as id, dir_path as "dirPath", state, signature, stable_since as "stableSince"
      from pool_items where scan_root_id = ${pool.scanRootId} and library_id = ${libraryId}`) as unknown as Item[];
  const byDir = new Map(items.map((i) => [i.dirPath, i]));
  const seen = new Set<string>();
  const ready: Array<{ id: string; group: Group }> = [];
  for (const g of groups) {
    seen.add(g.dir);
    const sig = signatureOf(g);
    const it = byDir.get(g.dir);
    if (!it) {
      const [row] = (await ctx.sql`
        insert into pool_items (library_id, scan_root_id, dir_path, state, signature, stable_since)
        values (${libraryId}, ${pool.scanRootId}, ${g.dir}, 'waiting', ${sig}, ${now.toISOString()}::timestamptz)
        on conflict (scan_root_id, dir_path) do nothing returning id::text as id`) as unknown as Array<{ id: string }>;
      if (row && data.itemId === row.id) ready.push({ id: row.id, group: g });
      continue;
    }
    if (it.signature !== sig) {
      // changed: wait again (an Inbox row whose files changed is looked at afresh; a skipped one stays skipped)
      if (['waiting', 'inbox', 'imported'].includes(it.state)) {
        await ctx.sql`update pool_items set state = 'waiting', reason = null, signature = ${sig}, stable_since = ${now.toISOString()}::timestamptz, updated_at = now()
                       where id = ${it.id}`;
      } else {
        await ctx.sql`update pool_items set signature = ${sig}, updated_at = now() where id = ${it.id}`;
      }
      continue;
    }
    const since = it.stableSince ? new Date(it.stableSince) : now;
    if ((it.state === 'waiting' && isStill(g, since, now)) || (data.itemId === it.id && !g.partial && ['waiting', 'inbox'].includes(it.state))) {
      ready.push({ id: it.id, group: g });
    }
  }
  // folders gone from the pool (moved out by hand, or imported and trashed)
  const gone = items.filter((i) => !seen.has(i.dirPath) && ['waiting', 'inbox', 'skipped', 'identifying'].includes(i.state)).map((i) => i.id);
  if (gone.length) await ctx.sql`delete from pool_items where id = any(${gone}::uuid[])`;

  let imported = 0;
  let inbox = 0;
  for (const r of ready) {
    const claimed = await ctx.sql`update pool_items set state = 'identifying', updated_at = now() where id = ${r.id} and state in ('waiting', 'inbox') returning id`;
    if (claimed.length === 0) continue;
    try {
      const outcome = await identifyDrop(ctx, libraryId, root.path, r.id, r.group, deps);
      if (outcome === 'importing') imported++;
      else inbox++;
    } catch (err) {
      ctx.logger.warn({ itemId: r.id, err: (err as Error).message }, 'pool.scan: identify failed');
      await ctx.sql`update pool_items set state = 'inbox', reason = 'failed', error = ${(err as Error).message.slice(0, 300)}, updated_at = now() where id = ${r.id}`;
      inbox++;
    }
  }
  return { albums: groups.length, waiting: groups.length - ready.length, imported, inbox, gone: gone.length };
}

const mostCommon = (xs: Array<string | null | undefined>): string | null => {
  const n = new Map<string, number>();
  for (const x of xs) if (x && x.trim()) n.set(x.trim(), (n.get(x.trim()) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
const str = (v: unknown): string | null => (Array.isArray(v) ? (v[0] ?? null) : typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => { const n = Number.parseInt(String(str(v) ?? ''), 10); return Number.isFinite(n) && n > 0 ? n : null; };

/** Identify one dropped album and decide: import it, or leave it for the owner. */
async function identifyDrop(ctx: WorkerContext, libraryId: string, root: string, itemId: string, g: Group, deps: PoolDeps): Promise<'importing' | 'inbox'> {
  // the files as their tags read
  const read: Array<PoolFile & { fields: ReturnType<typeof currentFieldsFrom> }> = [];
  for (const a of g.audio.sort((x, y) => x.relPath.localeCompare(y.relPath))) {
    try {
      const meta = await parseFile(path.join(root, a.relPath), { duration: true });
      const fields = currentFieldsFrom(tagSnapshotOf(meta));
      read.push({
        relPath: a.relPath, size: a.size, fields,
        title: str(fields.title), artist: str(fields.artist), album: str(fields.album), albumartist: str(fields.albumartist),
        disc: int(fields.discnumber), track: int(fields.tracknumber),
        durationMs: meta.format.duration ? Math.round(meta.format.duration * 1000) : null,
      });
    } catch (err) {
      ctx.logger.warn({ file: a.relPath, err: (err as Error).message }, 'pool.scan: unreadable file');
    }
  }
  const files: PoolFile[] = read.map(({ fields: _f, ...f }) => f);
  const title = mostCommon(read.map((r) => r.album)) ?? path.posix.basename(g.dir);
  const artist = mostCommon(read.map((r) => r.albumartist ?? r.artist));
  const year = int(mostCommon(read.map((r) => str(r.fields.originaldate) ?? str(r.fields.date)))?.slice(0, 4));
  const rows = read.map((r) => ({
    id: r.relPath, discNo: r.disc, trackNo: r.track,
    titleGuess: r.title ?? path.posix.basename(r.relPath).replace(/\.[^.]+$/, ''), artistGuess: r.artist, durationMs: r.durationMs,
  }));
  const view = localTrackViews(rows);
  const embeddedMbid = mostCommon(read.map((r) => str(r.fields.musicbrainz_albumid)));
  const local = {
    artist: artist ?? '', title, tracks: view.tracks, discsKnown: view.discsKnown,
    ...(view.discsKnown ? { discCount: view.discCount } : {}),
    ...(year ? { year } : {}),
    ...(embeddedMbid ? { embeddedMbId: embeddedMbid } : {}),
  };

  // candidates: identify's search, its cache and its 1 req/s pace
  const settings = await libraryProviderSettings(ctx, libraryId);
  const p = getProviders(settings);
  const release = deps.release ?? ((mbid: string) => mbRelease(ctx, p, mbid));
  const search = deps.search ?? ((q: ReleaseQuery) => mbSearch(ctx, p, q));
  const fetched: CanonicalRelease[] = [];
  const take = (r: CanonicalRelease) => { if (!fetched.some((x) => x.id === r.id)) fetched.push(r); };
  if (embeddedMbid) {
    try { take(await release(embeddedMbid)); } catch (err) { if ((err as { status?: number }).status !== 404) throw err; }
  }
  const fast = fetched[0] ? fastPathOutcome(scoreCandidates(local, [toScorable(fetched[0])])[0]?.distance ?? 1, fetched[0].tracks.length, rows.length) : 'weak';
  if (fast === 'weak') {
    let found = artist ? await search({ albumTitle: title, artistName: artist }) : [];
    if (found.length === 0) found = await search({ albumTitle: title });
    const plausible = found
      .filter((c) => !c.release.tracks?.length || Math.abs(c.release.tracks.length - rows.length) <= 5)
      .slice(0, MAX_LOOKUPS);
    for (const c of plausible) take(await release(c.release.id));
  }
  // AcoustID, as identify's fingerprint pass, when the library fingerprints and the tags found nothing
  let coverage: Record<string, number> = {};
  if (fetched.length === 0 && settings.fingerprintingEnabled && p.acoustid) {
    const perTrack: AcoustIdRecording[][] = [];
    for (const r of read) {
      try {
        const fp = await fpcalcFingerprint(path.join(root, r.relPath));
        const key = cacheKey('acoustid-lookup', fingerprintHash(fp.fingerprint));
        perTrack.push(await cached<AcoustIdRecording[]>(ctx.sql, 'acoustid', key, 30 * 24 * 3600, () =>
          acoustidCall(ctx, () => p.acoustid!.lookup(fp.fingerprint, Math.round(fp.durationS)))));
      } catch (err) {
        ctx.logger.warn({ file: r.relPath, err: (err as Error).message }, 'pool.scan: fingerprint lookup failed');
        perTrack.push([]);
      }
    }
    const ranked = rankAcoustIdReleases(perTrack).filter((x) => x.coverage >= 0.5).slice(0, MAX_LOOKUPS);
    coverage = Object.fromEntries(ranked.map((x) => [x.mbid, x.coverage]));
    for (const x of ranked) { try { take(await release(x.mbid)); } catch { /* skipped */ } }
  }

  const done = async (state: 'inbox', reason: 'unsure' | 'unidentified' | 'in_library', extra: { candidates?: PoolCandidate[]; best?: string | null; percent?: number | null; pairing?: PoolPairing[]; existing?: string | null } = {}) => {
    await ctx.sql`
      update pool_items set state = ${state}, reason = ${reason}, files = ${JSON.stringify(files)}::jsonb,
             candidates = ${JSON.stringify(extra.candidates ?? [])}::jsonb, best_release_id = ${extra.best ?? null}::uuid,
             best_percent = ${extra.percent ?? null}, pairing = ${JSON.stringify(extra.pairing ?? [])}::jsonb,
             existing_album_id = ${extra.existing ?? null}::uuid, error = null, updated_at = now()
       where id = ${itemId}`;
    return 'inbox' as const;
  };
  if (fetched.length === 0 || read.length === 0) return done('inbox', 'unidentified');

  const scored = scoreCandidates(local, fetched.map(toScorable));
  const dbIds = new Map<string, string>();
  for (const r of fetched) dbIds.set(r.id, (await persistFetched(ctx, r)).releaseId);
  const candidates: PoolCandidate[] = scored.flatMap((s) => {
    const r = fetched.find((x) => x.id === s.id);
    const id = dbIds.get(s.id);
    if (!r || !id) return [];
    return [{
      releaseId: id, mbid: r.source === 'musicbrainz' ? r.id : null, title: r.title, artist: r.artists.join(', '),
      year: r.year ?? null, country: r.country ?? null, format: r.media ?? null,
      tracks: r.tracks.filter((t) => !(t as { isDataTrack?: boolean }).isDataTrack).length, percent: matchPercent(s.distance),
    }];
  });

  // confident: identify's own rule, the fingerprint rule, then the owner's auto-accept rules when on
  let chosen: string | null = null;
  const decision = decideAuto(scored, local.tracks.length, fetched, rows.map((r) => r.discNo));
  if (decision.kind === 'accept') chosen = decision.candidate.id;
  if (!chosen) {
    const fp = scored.find((s) => (coverage[s.id] ?? 0) >= ACOUSTID_ACCEPT_COVERAGE && Math.abs((s.tracks?.length ?? 0) - local.tracks.length) <= 1);
    if (fp) chosen = fp.id;
  }
  if (!chosen) {
    const rules = await loadRules(ctx, libraryId);
    if (rules.enabled) {
      const byRules = evaluateAutoAccept(rules, { title, artist, year: year ?? null, trackCount: rows.length }, scored.map((s) => {
        const r = fetched.find((x) => x.id === s.id)!;
        return {
          id: s.id, distance: s.distance, provider: r.source, status: r.status ?? null,
          title: r.title, artist: r.artists.join(', ') || null, date: r.date ?? (r.year ? String(r.year) : null), country: r.country ?? null,
          trackCount: r.tracks.length, breakdown: s.breakdown as Record<string, unknown>,
        };
      }));
      if (byRules.accept) chosen = byRules.candidate.id;
    }
  }
  const bestMb = chosen ?? scored[0]!.id;
  const bestDb = dbIds.get(bestMb)!;
  const bestPercent = matchPercent((scored.find((s) => s.id === bestMb) ?? scored[0]!).distance);
  // how the files pair with the best release's tracks (Inbox shows it)
  const canon = (await ctx.sql`
    select id::text as id, medium_no as "mediumNo", position, title, length_ms as "lengthMs", artist_credit as "artistCredit",
           recording_mbid as "recordingMbid", track_mbid as "trackMbid"
      from canonical_tracks where release_id = ${bestDb} and not coalesce(is_data_track, false) and not coalesce(is_video, false)
     order by coalesce(medium_no, 1), position`) as unknown as Array<{ id: string; mediumNo: number | null; position: number | null; title: string; lengthMs: number | null; artistCredit: unknown; recordingMbid: string | null; trackMbid: string | null }>;
  const links = new Map(planTrackLinks(rows, canon).map((l) => [l.id, l]));
  const pairing: PoolPairing[] = rows.map((r) => {
    const l = links.get(r.id);
    const c = l?.canonicalTrackId ? canon.find((x) => x.id === l.canonicalTrackId) : undefined;
    return { relPath: r.id, disc: c?.mediumNo ?? null, position: c?.position ?? null, title: c?.title ?? null, confidence: c && l ? moveConfidence(l.distance) : null };
  });

  // already in the library: never merged or overwritten on its own
  const [held] = (await ctx.sql`
    select la.id::text as id from local_albums la
      join releases r on r.id = ${bestDb}
     where la.library_id = ${libraryId} and la.release_group_id = r.release_group_id
       and exists (select 1 from local_tracks lt join files f on f.id = lt.audio_file_id
                    where lt.local_album_id = la.id and f.status = 'present'
                      and not exists (select 1 from file_deletions fd where fd.file_id = f.id))
     order by la.state = 'matched' desc, la.track_count desc nulls last limit 1`) as unknown as Array<{ id: string }>;
  const extra = { candidates, best: bestDb, percent: bestPercent, pairing, existing: held?.id ?? null };
  if (held) return done('inbox', 'in_library', extra);
  if (!chosen) return done('inbox', 'unsure', extra);

  await ctx.sql`
    update pool_items set files = ${JSON.stringify(files)}::jsonb, candidates = ${JSON.stringify(candidates)}::jsonb,
           best_release_id = ${bestDb}, best_percent = ${bestPercent}, pairing = ${JSON.stringify(pairing)}::jsonb, reason = null, updated_at = now()
     where id = ${itemId}`;
  await queueImport(ctx, libraryId, itemId, bestDb);
  ctx.logger.info({ itemId, release: bestMb, percent: bestPercent }, 'pool.scan: confident, importing');
  return 'importing';
}
