/**
 * Which vanished file is which new file (move-safe scanning §1, merge rules).
 * Pure: the callers load rows, this decides; nothing here touches the database.
 *
 * - Only unique 1:1 pairs: an old row with exactly one candidate that has
 *   exactly one candidate back.
 * - Directory pairs first: when at least 80% of an old folder's vanished files
 *   map uniquely onto one new folder, the ambiguous rest of that folder is
 *   settled inside the pair by file name, then track and disc number.
 * - Edition guard: a folder pair whose new folder still has unpaired new
 *   files after settling is no pair at all (a deluxe edition is a new album).
 * - A new row only stands for an old one if it appeared after the old one was
 *   last seen, so the order roots are scanned in does not matter.
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

export function signatureMatches(tier: Tier, o: MatchFile, f: MatchFile): boolean {
  if (tier === 1) {
    if (o.sizeBytes === null || o.sizeBytes !== f.sizeBytes) return false;
    // dev:ino carries the device, so equal strings mean the same device (R12)
    if (o.inode && f.inode && o.inode === f.inode) return true;
    return o.mtime !== null && o.mtime === f.mtime && nameKey(o) === nameKey(f);
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
    for (const f of pool) {
      if (f.id === o.id) continue;
      if (f.firstSeenAt.getTime() < o.lastSeenAt.getTime()) continue;
      if (!signatureMatches(tier, o, f)) continue;
      push(cand, o.id, f);
      push(back, f.id, o);
    }
  }

  const freshById = new Map(freshs.map((f) => [f.id, f]));
  const unique = new Map<string, string>(); // old id -> fresh id
  for (const o of olds) {
    const c = cand.get(o.id) ?? [];
    if (c.length === 1 && (back.get(c[0]!.id) ?? []).length === 1) unique.set(o.id, c[0]!.id);
  }

  // Directory pairs: per old folder, the new folder most of its unique pairs land in.
  const oldsByDir = new Map<string, MatchFile[]>();
  for (const o of olds) push(oldsByDir, dirKey(o), o);
  const freshsByDir = new Map<string, MatchFile[]>();
  for (const f of freshs) push(freshsByDir, dirKey(f), f);
  const dirPairs: Array<{ oldDir: string; newDir: string }> = [];
  for (const [oldDir, members] of oldsByDir) {
    const flow = new Map<string, number>();
    for (const o of members) {
      const fid = unique.get(o.id);
      if (fid) flow.set(dirKey(freshById.get(fid)!), (flow.get(dirKey(freshById.get(fid)!)) ?? 0) + 1);
    }
    let best: [string, number] | null = null;
    for (const e of flow) if (!best || e[1] > best[1]) best = e;
    if (best && best[1] / members.length >= DIR_PAIR_RATIO) dirPairs.push({ oldDir, newDir: best[0] });
  }

  const taken = new Set(unique.values());
  const settled = new Map<string, string>(); // old id -> fresh id, inside dir pairs
  const dropped = new Set<string>();         // old ids whose dir pair the edition guard cancelled
  const possibleMoves: PossibleMove[] = [];
  const pairedIn = new Set<string>();        // old ids paired through a dir pair

  for (const { oldDir, newDir } of dirPairs) {
    const members = oldsByDir.get(oldDir)!;
    const free = (freshsByDir.get(newDir) ?? []).filter((f) => !taken.has(f.id));
    const choice = new Map<string, string>();
    for (const o of members) {
      if (unique.has(o.id)) continue;
      let options = (cand.get(o.id) ?? []).filter((f) => free.includes(f));
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
    const chosenCount = new Map<string, number>();
    for (const fid of choice.values()) chosenCount.set(fid, (chosenCount.get(fid) ?? 0) + 1);
    const pairHere = new Map<string, string>();
    for (const o of members) {
      const u = unique.get(o.id);
      if (u && dirKey(freshById.get(u)!) === newDir) pairHere.set(o.id, u);
    }
    for (const [oid, fid] of choice) if (chosenCount.get(fid) === 1) pairHere.set(oid, fid);

    // Edition guard: new files in the new folder nothing paired with.
    const pairedFresh = new Set([...taken, ...pairHere.values(), ...settled.values()]);
    const extras = (freshsByDir.get(newDir) ?? []).filter((f) => !pairedFresh.has(f.id) && !isOlderResident(f, members));
    if (extras.length > 0) {
      for (const oid of pairHere.keys()) dropped.add(oid);
      possibleMoves.push({ oldIds: [...pairHere.keys()].sort(), freshIds: [...pairHere.values()].sort(), reason: 'edition' });
      continue;
    }
    for (const [oid, fid] of pairHere) {
      if (!unique.has(oid)) { settled.set(oid, fid); taken.add(fid); }
      pairedIn.add(oid);
    }
  }

  const pairs: PlannedPair[] = [];
  for (const [oid, fid] of unique) if (!dropped.has(oid)) pairs.push({ oldId: oid, freshId: fid, dirPair: pairedIn.has(oid) });
  for (const [oid, fid] of settled) pairs.push({ oldId: oid, freshId: fid, dirPair: true });

  const paired = new Set(pairs.map((p) => p.oldId));
  for (const o of olds) {
    const c = cand.get(o.id) ?? [];
    if (c.length > 0 && !paired.has(o.id) && !dropped.has(o.id)) {
      possibleMoves.push({ oldIds: [o.id], freshIds: c.map((f) => f.id).sort(), reason: 'ambiguous' });
    }
  }
  pairs.sort((a, b) => a.oldId.localeCompare(b.oldId));
  return { pairs, possibleMoves };
}

/**
 * A file that was already in the new folder before any of these old files
 * vanished is not an extra. `<=`: rows inserted in one walk batch share one
 * now(), so equal timestamps mean the files coexisted (pre-flight F1).
 */
function isOlderResident(f: MatchFile, members: MatchFile[]): boolean {
  let earliestGone = Infinity;
  for (const m of members) earliestGone = Math.min(earliestGone, m.lastSeenAt.getTime());
  return f.firstSeenAt.getTime() <= earliestGone;
}
