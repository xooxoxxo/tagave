/**
 * Review queue (spec IDN-4): keyboard-first triage.
 *
 * This screen is used hundreds of times in a row, so it is built as a
 * comparison table rather than a list of cards. Candidates differ from each
 * other by a handful of facts (year, country, track count, source); those get
 * columns, so the eye scans down one column instead of re-reading five nearly
 * identical blocks. The scoring breakdown renders as a fixed-order strip of
 * cells rather than a labelled pill per key: the labels repeat on every row and
 * carry no information, only the colours do.
 *
 * n/p or j/k = next/prev album · up/down = candidate · Enter = accept ·
 * a = keep as-is · x = ignore · e = exclude candidate · ? = help
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentLibrary } from '../hooks';
import { api } from '../services/api';
import styles from './QueuePage.module.css';

interface QueueTrack {
  id: string;
  discNo: number | null;
  trackNo: number | null;
  title: string | null;
  durationMs: number | null;
}
interface QueueCandidate {
  id: string;
  releaseId: string;
  releaseMbid: string | null;
  discogsReleaseId: number | null;
  title: string;
  artistCredit: string;
  date: string | null;
  country: string | null;
  status: string | null;
  trackCount: number | null;
  distance: number;
  breakdown: Record<string, number>;
  source: string;
  provider: string;
  rgMbid: string | null;
}
interface QueueItem {
  id: string;
  title: string | null;
  artist: string | null;
  year: number | null;
  dirPaths: string[];
  trackCount: number | null;
  formats: string[];
  bestDistance: number | null;
  tracks: QueueTrack[];
  candidates: QueueCandidate[];
}

function fmtDur(ms: number | null): string {
  if (!ms) return '–:––';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Year only. The full date is available on hover; the year is what decides. */
function fmtYear(date: string | null): string {
  if (!date) return '—';
  return date.slice(0, 4);
}

/** 0 = agrees, < 0.5 = close, >= 0.5 = disagrees. Same thresholds as the chip rule. */
function scoreClass(v: number): string {
  if (v === 0) return styles.cellGood ?? '';
  if (v < 0.5) return styles.cellNear ?? '';
  return styles.cellBad ?? '';
}

function scoreWord(v: number): string {
  if (v === 0) return 'agrees';
  if (v < 0.5) return 'close';
  return 'disagrees';
}

export function ReviewPanel() {
  const { libraryId } = useCurrentLibrary();
  const queryClient = useQueryClient();
  const [itemIdx, setItemIdx] = useState(0);
  const [candIdx, setCandIdx] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['queue', libraryId],
    queryFn: () =>
      api.get<{ items: QueueItem[]; nextCursor: string | null; total?: number }>(
        `/libraries/${libraryId}/queue?limit=50`,
      ),
    enabled: !!libraryId,
  });

  const items = data?.items ?? [];
  const totalLeft = data?.total ?? items.length;
  const item = items[itemIdx];
  const candidate = item?.candidates[candIdx];

  // One stable column order for the whole album, taken from the union of every
  // candidate's breakdown keys. Without this the cells would shift between rows
  // and the column could not be read downwards, which is the entire point.
  const scoreKeys = useMemo(() => {
    const seen = new Set<string>();
    for (const c of item?.candidates ?? []) {
      for (const [k, v] of Object.entries(c.breakdown ?? {})) {
        if (typeof v === 'number') seen.add(k);
      }
    }
    return [...seen].sort();
  }, [item]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['queue', libraryId] });

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api.post(path, body),
    onSuccess: refresh,
  });

  const decide = useCallback(
    (kind: 'match' | 'as-is' | 'ignore' | 'exclude') => {
      if (!item) return;
      if (kind === 'match') {
        if (!candidate) return;
        act.mutate({ path: `/albums/${item.id}/match`, body: { candidateId: candidate.id } });
      } else if (kind === 'exclude') {
        if (!candidate) return;
        act.mutate({ path: `/albums/${item.id}/exclude-candidate`, body: { candidateId: candidate.id } });
      } else {
        act.mutate({ path: `/albums/${item.id}/${kind}` });
      }
      setCandIdx(0);
    },
    [item, candidate, act],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case 'n': case 'j':
          setItemIdx((i) => Math.min(i + 1, items.length - 1)); setCandIdx(0); break;
        case 'p': case 'k':
          setItemIdx((i) => Math.max(i - 1, 0)); setCandIdx(0); break;
        case 'ArrowDown':
          e.preventDefault();
          setCandIdx((c) => Math.min(c + 1, (item?.candidates.length ?? 1) - 1)); break;
        case 'ArrowUp':
          e.preventDefault();
          setCandIdx((c) => Math.max(c - 1, 0)); break;
        case 'Enter': decide('match'); break;
        case 'a': decide('as-is'); break;
        case 'x': decide('ignore'); break;
        case 'e': decide('exclude'); break;
        case '?': setShowHelp((h) => !h); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items.length, item, decide]);

  if (isLoading) return <div className={styles.loading}>Loading queue…</div>;
  if (!items.length) {
    return (
      <div className={styles.emptyState}>
        Queue is empty — nothing needs your judgment right now.
      </div>
    );
  }
  if (!item) return null;

  const localTrackCount = item.trackCount ?? item.tracks.length;

  return (
    <div className={styles.review}>
      {/* Identity and progress on one line each. This used to be a tall panel
          stretched to the height of the candidate list, which left a few
          hundred pixels of nothing on every album. */}
      <div className={styles.albumBar}>
        <div className={styles.albumIdentity}>
          <h2 className={styles.albumName}>{item.title ?? 'Untitled'}</h2>
          <p className={styles.albumMeta}>
            {item.artist ?? 'Unknown artist'}
            {item.year ? ` · ${item.year}` : ''}
            {` · ${localTrackCount} file${localTrackCount === 1 ? '' : 's'}`}
            {item.formats?.length ? ` · ${item.formats.join(', ')}` : ''}
          </p>
          {item.dirPaths?.[0] && <p className={styles.albumPath} title={item.dirPaths[0]}>{item.dirPaths[0]}</p>}
        </div>
        <p className={styles.progress}>
          <strong>{totalLeft}</strong> left
          <span className={styles.progressSep}>·</span>
          {itemIdx + 1} of {items.length} loaded
        </p>
      </div>

      {item.candidates.length === 0 ? (
        <div className={styles.noCandidates}>
          No candidate matched this album. Keep the local tags with <kbd>a</kbd>, or set it aside with <kbd>x</kbd>.
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>
              Candidate releases for {item.title ?? 'this album'}, best match first. Use up and down arrows to select.
            </caption>
            <thead>
              <tr>
                <th scope="col" className={styles.colSource}>Source</th>
                <th scope="col">Release</th>
                <th scope="col" className={styles.colNum}>Year</th>
                <th scope="col" className={styles.colNum}>Country</th>
                <th scope="col" className={styles.colNum}>Tracks</th>
                {/* Match before Status: it is the decision signal, and Status is
                    "—" for most Discogs releases. At narrow widths the columns
                    after this one are the first to go behind the scroll. */}
                <th scope="col" className={styles.colScores}>Match</th>
                <th scope="col">Status</th>
                <th scope="col" className={styles.colNum}>Distance</th>
                <th scope="col" className={styles.colLinks}><span className={styles.srOnly}>Links</span></th>
              </tr>
            </thead>
            <tbody>
              {item.candidates.map((c, i) => {
                const selected = i === candIdx;
                const trackDelta = c.trackCount != null && localTrackCount
                  ? c.trackCount - localTrackCount
                  : null;
                return (
                  <tr
                    key={c.id}
                    className={selected ? styles.rowSelected : styles.row}
                    aria-selected={selected}
                    onClick={() => setCandIdx(i)}
                  >
                    <td className={styles.colSource}>
                      <span className={styles.provider}>{c.provider === 'discogs' ? 'Discogs' : 'MusicBrainz'}</span>
                    </td>
                    <td className={styles.release}>
                      <span className={styles.releaseTitle}>{c.title}</span>
                      {c.artistCredit && c.artistCredit !== item.artist && (
                        <span className={styles.releaseArtist}>{c.artistCredit}</span>
                      )}
                    </td>
                    <td className={styles.colNum} title={c.date ?? undefined}>{fmtYear(c.date)}</td>
                    <td className={styles.colNum}>{c.country ?? '—'}</td>
                    <td className={styles.colNum}>
                      {c.trackCount ?? '—'}
                      {trackDelta != null && trackDelta !== 0 && (
                        <span className={styles.delta} title={`${Math.abs(trackDelta)} ${trackDelta > 0 ? 'more' : 'fewer'} than on disk`}>
                          {trackDelta > 0 ? `+${trackDelta}` : trackDelta}
                        </span>
                      )}
                    </td>
                    <td className={styles.colScores}>
                      <span className={styles.scoreStrip}>
                        {scoreKeys.map((k) => {
                          const v = c.breakdown?.[k];
                          if (typeof v !== 'number') {
                            return <span key={k} className={styles.cellNone} title={`${k}: not scored`} />;
                          }
                          return (
                            <span
                              key={k}
                              className={scoreClass(v)}
                              title={`${k}: ${scoreWord(v)} (${v.toFixed(3)})`}
                            />
                          );
                        })}
                      </span>
                    </td>
                    <td className={styles.status}>{c.status ?? '—'}</td>
                    <td className={styles.colNum}>
                      <span className={styles.distance}>{c.distance.toFixed(3)}</span>
                    </td>
                    <td className={styles.colLinks}>
                      {c.releaseMbid && (
                        <a
                          href={`https://musicbrainz.org/release/${c.releaseMbid}`}
                          target="_blank"
                          rel="noreferrer"
                          className={styles.link}
                          title="Open on MusicBrainz"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className={styles.srOnly}>Open on MusicBrainz</span>↗
                        </a>
                      )}
                      {c.discogsReleaseId && (
                        <a
                          href={`https://www.discogs.com/release/${c.discogsReleaseId}`}
                          target="_blank"
                          rel="noreferrer"
                          className={styles.link}
                          title="Open on Discogs"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className={styles.srOnly}>Open on Discogs</span>↗
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {scoreKeys.length > 0 && (
            <p className={styles.legend}>
              Match cells, left to right: {scoreKeys.join(', ')}.
              <span className={styles.legendKey}><span className={styles.cellGood} /> agrees</span>
              <span className={styles.legendKey}><span className={styles.cellNear} /> close</span>
              <span className={styles.legendKey}><span className={styles.cellBad} /> disagrees</span>
            </p>
          )}
        </div>
      )}

      <details className={styles.tracks}>
        <summary className={styles.tracksSummary}>
          {localTrackCount} track{localTrackCount === 1 ? '' : 's'} on disk
        </summary>
        <ol className={styles.trackList}>
          {item.tracks.map((t) => (
            <li key={t.id} className={styles.trackRow}>
              <span className={styles.trackNo}>{t.trackNo ?? '–'}</span>
              <span className={styles.trackTitle}>{t.title ?? '(untitled)'}</span>
              <span className={styles.trackDur}>{fmtDur(t.durationMs)}</span>
            </li>
          ))}
        </ol>
      </details>

      {/* Pinned: on a 170-item queue, a scroll per decision is 170 scrolls. */}
      <div className={styles.actionBar}>
        <div className={styles.actionButtons}>
          <button type="button" className={styles.primary} onClick={() => decide('match')} disabled={!candidate}>
            Accept match
          </button>
          <button type="button" className={styles.secondary} onClick={() => decide('as-is')}>
            Keep as-is
          </button>
          <button type="button" className={styles.secondary} onClick={() => decide('ignore')}>
            Ignore album
          </button>
        </div>
        <div className={styles.shortcuts}>
          <kbd>↵</kbd> accept <kbd>a</kbd> as-is <kbd>x</kbd> ignore <kbd>e</kbd> exclude
          <span className={styles.shortcutSep} />
          <kbd>↑</kbd><kbd>↓</kbd> candidate <kbd>n</kbd><kbd>p</kbd> album
          <button type="button" className={styles.helpToggle} onClick={() => setShowHelp((h) => !h)} aria-expanded={showHelp}>
            {showHelp ? 'Hide keys' : 'All keys'}
          </button>
        </div>
      </div>

      {showHelp && (
        <div className={styles.helpBox}>
          <b>n</b> or <b>j</b> next album · <b>p</b> or <b>k</b> previous album ·
          <b> ↑ ↓</b> select candidate · <b>Enter</b> accept the selected candidate ·
          <b> a</b> keep the local tags as they are · <b>x</b> ignore this folder ·
          <b> e</b> exclude the selected candidate from future consideration ·
          <b> ?</b> toggle this help
        </div>
      )}
    </div>
  );
}

// Legacy export for backwards compatibility
export function QueuePage() {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Review Queue</h1>
      </div>
      <ReviewPanel />
    </div>
  );
}
