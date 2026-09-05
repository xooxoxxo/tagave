/**
 * Review queue (spec IDN-4): keyboard-first two-pane decision UI.
 * n/p or j/k = next/prev album · up/down = candidate · Enter = accept ·
 * a = keep as-is · x = ignore · e = exclude candidate · ? = help
 */
import { useCallback, useEffect, useState } from 'react';
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

export function QueuePage() {
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

  if (isLoading) return <div className={styles.container}>Loading queue...</div>;
  if (!items.length) {
    return (
      <div className={styles.container}>
        <h1 className={styles.title}>Review Queue</h1>
        <div className={styles.emptyState}>
          Queue is empty — nothing needs your judgment right now.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Review Queue</h1>
        <span className={styles.counter}>{totalLeft} left{items.length < totalLeft ? ` · viewing ${itemIdx + 1}/${items.length}` : ` · on ${itemIdx + 1}`}</span>
        <span className={styles.keysHint}>
          n/p albums · ↑↓ candidates · Enter accept · a as-is · x ignore · e exclude · ?
        </span>
      </div>

      {showHelp && (
        <div className={styles.helpBox}>
          <b>Keys:</b> n or j next album · p or k previous · ↑/↓ select candidate ·
          Enter accept selected candidate · a keep local tags as-is · x ignore folder ·
          e exclude selected candidate from future consideration · ? toggle this help
        </div>
      )}

      {item && (
        <div className={styles.panes}>
          <section className={styles.localPane}>
            <h2 className={styles.paneTitle}>On disk</h2>
            <div className={styles.albumHead}>
              <div className={styles.albumName}>{item.title ?? 'Untitled'}</div>
              <div className={styles.albumArtist}>{item.artist ?? 'Unknown artist'}{item.year ? ` · ${item.year}` : ''}</div>
              <div className={styles.dirPath}>{item.dirPaths?.[0]}</div>
              <div className={styles.badges}>{item.trackCount} files · {item.formats?.join(', ')}</div>
            </div>
            <ol className={styles.trackList}>
              {item.tracks.map((t) => (
                <li key={t.id} className={styles.trackRow}>
                  <span className={styles.trackNo}>{t.trackNo ?? '–'}</span>
                  <span className={styles.trackTitle}>{t.title ?? '(untitled)'}</span>
                  <span className={styles.trackDur}>{fmtDur(t.durationMs)}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className={styles.candidatesPane}>
            <h2 className={styles.paneTitle}>Candidates</h2>
            {item.candidates.length === 0 && (
              <div className={styles.noCandidates}>
                No good candidates. <kbd>a</kbd> keep as-is or <kbd>x</kbd> ignore.
              </div>
            )}
            {item.candidates.map((c, i) => (
              <div
                key={c.id}
                className={i === candIdx ? styles.candidateSelected : styles.candidate}
                onClick={() => setCandIdx(i)}
              >
                <div className={styles.candHead}>
                  <span className={styles.candProvider}>{c.provider === 'discogs' ? 'Discogs' : 'MB'}</span>
                  <span className={styles.candTitle}>{c.artistCredit} — {c.title}</span>
                  {c.releaseMbid && (
                    <a
                      href={`https://musicbrainz.org/release/${c.releaseMbid}`}
                      target="_blank"
                      rel="noreferrer"
                      className={styles.candLink}
                      title="MusicBrainz"
                    >
                      ↗
                    </a>
                  )}
                  {c.discogsReleaseId && (
                    <a
                      href={`https://www.discogs.com/release/${c.discogsReleaseId}`}
                      target="_blank"
                      rel="noreferrer"
                      className={styles.candLink}
                      title="Discogs"
                    >
                      🔗
                    </a>
                  )}
                  <span className={styles.candDistance}>{c.distance.toFixed(4)}</span>
                </div>
                <div className={styles.candMeta}>
                  {[c.date, c.country, c.status, c.trackCount ? `${c.trackCount} tracks` : null, c.source]
                    .filter(Boolean).join(' · ')}
                </div>
                <div className={styles.chips}>
                  {Object.entries(c.breakdown ?? {})
                    .filter(([, v]) => typeof v === 'number')
                    .map(([k, v]) => (
                      <span
                        key={k}
                        className={v === 0 ? styles.chipGood : v < 0.5 ? styles.chipNear : styles.chipBad}
                        title={`${k}: ${v}`}
                      >
                        {k}
                      </span>
                    ))}
                </div>
              </div>
            ))}
            <div className={styles.actions}>
              <button onClick={() => decide('match')} disabled={!candidate}>Accept (Enter)</button>
              <button onClick={() => decide('as-is')}>Keep as-is (a)</button>
              <button onClick={() => decide('ignore')}>Ignore (x)</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
