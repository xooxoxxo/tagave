/**
 * Which vanished file is which new file (move-safe scanning §1, merge rules).
 * Pure: the callers load rows, this decides; nothing here touches the database.
 *
 * - Only unique 1:1 pairs: an old row with exactly one candidate that has
 *   exactly one candidate back.
 * - Directory pairs first: when at least 80% of an old folder's vanished files
 *   map uniquely onto one new folder, the ambiguous rest of that folder is
 *   settled inside the pair by file name, then track and disc number. A new
 *   row chosen by more than one old row (across all pairs) settles nothing.
 * - Edition guard, after all settling: a new folder that still holds unpaired
 *   new files keeps no pair at all (a deluxe edition is a new album). This
 *   covers unique pairs outside dir pairs too, and runs to a fixed point.
 * - A new row only stands for an old one if it appeared strictly after the old
 *   one was last seen (an equal time means both were seen in one walk batch,
 *   so they coexisted), so the order roots are scanned in does not matter.
 * - The output depends only on the set of rows, never on their input order.
 */
import { normKey, relBasename, relDirname } from './helpers.js';

export type Tier = 1 | 2;

export interface MatchFile {
  id: string;
  scanRootId: string;
  relPath: string;
  sizeBytes: number | null;
  mtime: number | null;
  inode: string | null;
  durationMs: number | null;
  coreTagsDigest: string | null;
  audioHash: string | null;
  trackNo: number | null;
  discNo: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface PlannedPair { oldId: string; freshId: string; dirPair: boolean }
export interface PossibleMove { oldIds: string[]; freshIds: string[]; reason: 'ambiguous' | 'edition' }
export interface PairPlan { pairs: PlannedPair[]; possibleMoves: PossibleMove[] }

export const DIR_PAIR_RATIO = 0.8;

const nameKey = (f: MatchFile) => normKey(relBasename(f.relPath));
const dirKey = (f: MatchFile) => `${f.scanRootId}\n${relDirname(f.relPath)}`;
/** Code-unit order: deterministic and locale-independent. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs: Iterable<string>) => [...xs].sort(cmp);

/** "<dev>:<ino>" with a real inode; empty or ino 0 (no inode from the share) never pairs. */
const usableInode = (s: string | null): s is string => !!s && !s.endsWith(':0') && s.includes(':');

export function signatureMatches(tier: Tier, o: MatchFile, f: MatchFile): boolean {
  if (tier === 1) {
    if (o.sizeBytes === null || o.sizeBytes !== f.sizeBytes) return false;
    // A rename or same-device move keeps mtime; inode reuse after a delete is
    // common, so dev:ino alone is not enough. dev:ino carries the device (inode numbers repeat across devices).
    if (o.mtime === null || o.mtime !== f.mtime) return false;
    if (usableInode(o.inode) && o.inode === f.inode) return true;
    return nameKey(o) === nameKey(f);
  }
  if (o.audioHash && f.audioHash && o.audioHash === f.audioHash) return true;
  return o.sizeBytes !== null && o.sizeBytes === f.sizeBytes
    && o.durationMs !== null && o.durationMs === f.durationMs
    && !!o.coreTagsDigest && o.coreTagsDigest === f.coreTagsDigest;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

export function planPairs(tier: Tier, olds: MatchFile[], freshs: MatchFile[]): PairPlan {
  // Canonical order first, so nothing below can depend on input order.
  olds = [...olds].sort((a, b) => cmp(a.id, b.id));
  freshs = [...freshs].sort((a, b) => cmp(a.id, b.id));

  // Candidate lists, bucketed by size (and by audio hash for Tier 2).
  const bySize = new Map<number, MatchFile[]>();
  const byHash = new Map<string, MatchFile[]>();
  for (const f of freshs) {
    if (f.sizeBytes !== null) push(bySize, f.sizeBytes, f);
    if (tier === 2 && f.audioHash) push(byHash, f.audioHash, f);
  }
  const cand = new Map<string, MatchFile[]>();
  const back = new Map<string, MatchFile[]>();
  for (const o of olds) {
    const pool = new Set<MatchFile>([
      ...(o.sizeBytes !== null ? bySize.get(o.sizeBytes) ?? [] : []),
      ...(tier === 2 && o.audioHash ? byHash.get(o.audioHash) ?? [] : []),
    ]);
    const list = [...pool].sort((a, b) => cmp(a.id, b.id));
    for (const f of list) {
      if (f.id === o.id) continue;
      // Strictly after: rows inserted in one walk batch share one now(), so a new row
      // first seen when the old one was last seen coexisted with it (as isOlderResident).
      if (f.firstSeenAt.getTime() <= o.lastSeenAt.getTime()) continue;
      if (!signatureMatches(tier, o, f)) continue;
      push(cand, o.id, f);
      push(back, f.id, o);
    }
  }

  const oldById = new Map(olds.map((o) => [o.id, o]));
  const freshById = new Map(freshs.map((f) => [f.id, f]));
  const unique = new Map<string, string>(); // old id -> fresh id
  for (const o of olds) {
    const c = cand.get(o.id) ?? [];
    if (c.length === 1 && (back.get(c[0]!.id) ?? []).length === 1) unique.set(o.id, c[0]!.id);
  }
  const uniqueFresh = new Set(unique.values());

  // Directory pairs: per old folder, the new folder most of its unique pairs
  // land in (ties broken by key). Denominator: the folder's vanished rows (files left behind are not moving).
  const oldsByDir = new Map<string, MatchFile[]>();
  for (const o of olds) push(oldsByDir, dirKey(o), o);
  const freshsByDir = new Map<string, MatchFile[]>();
  for (const f of freshs) push(freshsByDir, dirKey(f), f);
  const dirPairOf = new Map<string, string>(); // old dir -> new dir
  for (const [oldDir, members] of oldsByDir) {
    const flow = new Map<string, number>();
    for (const o of members) {
      const fid = unique.get(o.id);
      if (fid) {
        const d = dirKey(freshById.get(fid)!);
        flow.set(d, (flow.get(d) ?? 0) + 1);
      }
    }
    let best: [string, number] | null = null;
    for (const e of flow) if (!best || e[1] > best[1] || (e[1] === best[1] && e[0] < best[0])) best = e;
    if (best && best[1] / members.length >= DIR_PAIR_RATIO) dirPairOf.set(oldDir, best[0]);
  }

  // Settling, phase 1: every dir pair's choices, from rows no unique pair holds.
  const choice = new Map<string, string>(); // old id -> fresh id
  for (const [oldDir, newDir] of dirPairOf) {
    for (const o of oldsByDir.get(oldDir)!) {
      if (unique.has(o.id)) continue;
      let options = (cand.get(o.id) ?? []).filter((f) => !uniqueFresh.has(f.id) && dirKey(f) === newDir);
      // Narrow only when the rule leaves at least one option.
      if (options.length > 1) {
        const byName = options.filter((f) => nameKey(f) === nameKey(o));
        if (byName.length > 0) options = byName;
      }
      if (options.length > 1 && o.trackNo !== null) {
        const byNo = options.filter((f) => f.trackNo === o.trackNo && (f.discNo ?? 1) === (o.discNo ?? 1));
        if (byNo.length > 0) options = byNo;
      }
      if (options.length === 1) choice.set(o.id, options[0]!.id);
    }
  }
  // Phase 2: a fresh row settles only if exactly one old row chose it.
  const chosenCount = new Map<string, number>();
  for (const fid of choice.values()) chosenCount.set(fid, (chosenCount.get(fid) ?? 0) + 1);

  const active = new Map<string, string>(unique); // old id -> fresh id
  for (const [oid, fid] of choice) if (chosenCount.get(fid) === 1) active.set(oid, fid);

  // Edition guard over the final pair set, per fresh folder, to a fixed point.
  const pairedFresh = new Set(active.values());
  const intoDir = new Map<string, string[]>(); // fresh dir -> old ids paired into it
  for (const [oid, fid] of active) push(intoDir, dirKey(freshById.get(fid)!), oid);
  const dropped = new Set<string>();
  const editions: PossibleMove[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [freshDir, oids] of intoDir) {
      if (oids.length === 0) continue;
      // Earliest last_seen over the old rows being paired here (not every row of their dirs).
      let earliestGone = Infinity;
      for (const oid of oids) earliestGone = Math.min(earliestGone, oldById.get(oid)!.lastSeenAt.getTime());
      if (!(freshsByDir.get(freshDir) ?? []).some((f) => !pairedFresh.has(f.id) && !isOlderResident(f, earliestGone))) continue;
      // Drop every pair into this folder; one possible move per old folder (a deluxe edition is a new album, not a move).
      const byOldDir = new Map<string, string[]>();
      for (const oid of oids) push(byOldDir, dirKey(oldById.get(oid)!), oid);
      for (const group of byOldDir.values()) {
        editions.push({ oldIds: sorted(group), freshIds: sorted(group.map((oid) => active.get(oid)!)), reason: 'edition' });
      }
      for (const oid of oids) {
        pairedFresh.delete(active.get(oid)!);
        active.delete(oid);
        dropped.add(oid);
      }
      intoDir.set(freshDir, []);
      changed = true;
    }
  }

  const pairs: PlannedPair[] = [];
  for (const [oid, fid] of active) {
    const o = oldById.get(oid)!;
    pairs.push({ oldId: oid, freshId: fid, dirPair: dirPairOf.get(dirKey(o)) === dirKey(freshById.get(fid)!) });
  }
  pairs.sort((a, b) => cmp(a.oldId, b.oldId));

  const possibleMoves: PossibleMove[] = [...editions];
  for (const o of olds) {
    const c = cand.get(o.id) ?? [];
    if (c.length > 0 && !active.has(o.id) && !dropped.has(o.id)) {
      possibleMoves.push({ oldIds: [o.id], freshIds: sorted(c.map((f) => f.id)), reason: 'ambiguous' });
    }
  }
  possibleMoves.sort((a, b) => cmp(a.reason, b.reason) || cmp(a.oldIds[0]!, b.oldIds[0]!));
  return { pairs, possibleMoves };
}

/**
 * A file that was already in the new folder before the old files being paired
 * into it vanished is not an extra. `<=`: rows inserted in one walk batch share
 * one now(), so equal timestamps mean the files coexisted.
 */
function isOlderResident(f: MatchFile, earliestGone: number): boolean {
  return f.firstSeenAt.getTime() <= earliestGone;
}
