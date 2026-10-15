/**
 * Review matches (spec IDN-4): keyboard-first triage, one album at a time.
 *
 * The selected edition sits beside the files on disk, field by field (Album,
 * Artist, Year, Country, Tracks: ✓ agrees, ≈ close, ✗ differs), so the
 * difference is read rather than decoded. The editions found are a short
 * list beside it — provider mark (the link), year · country, a tag only when
 * the release is not Official, the edition details, and the match as a bar,
 * a percent and a word. Picking one swaps the comparison. An edition the
 * matcher missed can be pasted in; the owner's auto-accept rules live behind
 * the button by the album header. Every shortcut is behind "?".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { compareEdition, matchPercent, statusTag, type AutoAcceptView, type ComparisonRow } from '@tagave/shared';
import { useCurrentLibrary } from '../hooks';
import { api } from '../services/api';
import { Button, IconButton, Input } from '../components/ui';
import { MatchMeter, SourceIcon, StatusTag } from './review/reviewParts';
import { ShortcutsSheet } from './review/ReviewDialog';
import { AutoAcceptDialog } from './review/AutoAcceptDialog';
import styles from './review/review.module.css';

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
  labelName?: string | null;
  format?: string | null;
  catalogNumber?: string | null;
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

type AddResult =
  | { ok: true; candidateId: string; releaseId: string; distance: number; added: boolean }
  | { ok: false; message: string };

function fmtDur(ms: number | null): string {
  if (!ms) return '–:––';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Label · format · catalogue number, whatever the data has. */
function editionDetails(c: QueueCandidate): string {
  return [c.labelName, c.format, c.catalogNumber].filter(Boolean).join(' · ');
}

function sameText(a: string | null, b: string | null): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

const VERDICT_MARK = { agrees: '✓', close: '≈', differs: '✗', unknown: '–' } as const;
const VERDICT_WORD = { agrees: 'agrees', close: 'close', differs: 'differs', unknown: 'nothing to compare' } as const;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** How long the screen waits for a pasted edition before it gives up asking. */
const ADD_TIMEOUT_MS = 90_000;

export function ReviewPanel() {
  const { libraryId } = useCurrentLibrary();
  const queryClient = useQueryClient();
  // The album and edition are followed by id: the queue refetches on every
  // job event and is ordered by best match, so an index would jump.
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [fallbackIdx, setFallbackIdx] = useState(0);
  const [candId, setCandId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const pasteRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    // own key under ['queue', lib]: the tab count asks for limit=1
    queryKey: ['queue', libraryId, 'review'],
    queryFn: () =>
      api.get<{ items: QueueItem[]; nextCursor: string | null; total?: number }>(
        `/libraries/${libraryId}/queue?limit=50`,
      ),
    enabled: !!libraryId,
  });
  const rulesView = useQuery({
    queryKey: ['auto-accept', libraryId],
    queryFn: () => api.get<AutoAcceptView>(`/libraries/${libraryId}/auto-accept`),
    enabled: !!libraryId,
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const totalLeft = data?.total ?? items.length;
  const found = albumId ? items.findIndex((i) => i.id === albumId) : -1;
  const itemIdx = found >= 0 ? found : Math.max(0, Math.min(fallbackIdx, items.length - 1));
  const item = items[itemIdx];
  const foundCand = item && candId ? item.candidates.findIndex((c) => c.id === candId) : -1;
  const candIdx = foundCand >= 0 ? foundCand : 0;
  const candidate = item?.candidates[candIdx];

  // Follow whatever album is on screen, so a refetch keeps it there.
  useEffect(() => {
    if (item && item.id !== albumId) {
      setAlbumId(item.id);
      setFallbackIdx(itemIdx);
      setCandId(null);
    }
  }, [item, albumId, itemIdx]);

  const goAlbum = useCallback((idx: number) => {
    const next = items[Math.max(0, Math.min(idx, items.length - 1))];
    if (!next) return;
    setAlbumId(next.id);
    setFallbackIdx(Math.max(0, Math.min(idx, items.length - 1)));
    setCandId(null);
  }, [items]);
  const goCand = useCallback((idx: number) => {
    const next = item?.candidates[Math.max(0, Math.min(idx, item.candidates.length - 1))];
    if (next) setCandId(next.id);
  }, [item]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['queue', libraryId] });

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post(path, body),
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
        setCandId(null);
        return;
      } else {
        act.mutate({ path: `/albums/${item.id}/${kind}` });
      }
      // The decided album leaves the queue; the next one takes its place.
      setAlbumId(null);
      setFallbackIdx(itemIdx);
      setCandId(null);
    },
    [item, candidate, act, itemIdx],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showHelp || showRules) return; // the open sheet has the keyboard
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      switch (e.key) {
        case 'n': case 'j': goAlbum(itemIdx + 1); break;
        case 'p': case 'k': goAlbum(itemIdx - 1); break;
        case 'ArrowDown': e.preventDefault(); goCand(candIdx + 1); break;
        case 'ArrowUp': e.preventDefault(); goCand(candIdx - 1); break;
        case 'Enter':
          // Enter on a focused button or link is that control's own click.
          if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) return;
          decide('match');
          break;
        case 'a': decide('as-is'); break;
        case 'x': decide('ignore'); break;
        case 'e': decide('exclude'); break;
        case '/': e.preventDefault(); pasteRef.current?.focus(); break;
        case '?': setShowHelp(true); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [itemIdx, candIdx, goAlbum, goCand, decide, showHelp, showRules]);

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
  const rules = rulesView.data?.rules;
  const rows: ComparisonRow[] = candidate
    ? compareEdition(
      { title: item.title, artist: item.artist, year: item.year, trackCount: localTrackCount },
      { title: candidate.title, artist: candidate.artistCredit || null, date: candidate.date, country: candidate.country, trackCount: candidate.trackCount, breakdown: candidate.breakdown },
    )
    : [];
  const candTag = candidate ? statusTag(candidate.status) : null;

  return (
    <div className={styles.review}>
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
        <div className={styles.albumSide}>
          <p className={styles.progress}>
            <strong>{totalLeft}</strong> left
            <span className={styles.progressSep}>·</span>
            {itemIdx + 1} of {items.length} loaded
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowRules(true)}
            disabled={!rulesView.data}
            aria-haspopup="dialog"
          >
            <span className={rules?.enabled ? styles.dotOn : styles.dotOff} aria-hidden="true" />
            {`Auto-accept · ${rules?.enabled ? 'on' : 'off'}`}
          </Button>
        </div>
      </div>

      <div className={styles.panels}>
        <section className={styles.panel} aria-label="Selected edition beside your files">
          {candidate ? (
            <>
              <div className={styles.best}>
                <div className={styles.bestTitle}>
                  <SourceIcon edition={candidate} />
                  <div className={styles.bestText}>
                    <p className={styles.bestName}>
                      <span>{candidate.title}</span>
                      {candTag && <StatusTag status={candTag} />}
                    </p>
                    {editionDetails(candidate) && <p className={styles.bestSub}>{editionDetails(candidate)}</p>}
                  </div>
                </div>
                <MatchMeter percent={matchPercent(candidate.distance)} />
              </div>
              <table className={styles.compare}>
                <caption className={styles.srOnly}>The selected edition compared with the files on disk</caption>
                <colgroup>
                  <col className={styles.cField} />
                  <col />
                  <col />
                  <col className={styles.cMark} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col"><span className={styles.srOnly}>Field</span></th>
                    <th scope="col">On disk</th>
                    <th scope="col">This edition</th>
                    <th scope="col"><span className={styles.srOnly}>Verdict</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.field}>
                      <th scope="row">{r.label}</th>
                      <td className={styles.diskValue}>{r.disk ?? '—'}</td>
                      <td>{r.edition ?? '—'}</td>
                      <td className={styles.markCell}>
                        <span className={styles[`v_${r.verdict}`]} role="img" aria-label={VERDICT_WORD[r.verdict]} title={VERDICT_WORD[r.verdict]}>
                          {VERDICT_MARK[r.verdict]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className={styles.noCandidates}>
              No edition matched this album. Paste one if you know it, keep the files as they are, or ignore the album.
            </p>
          )}
        </section>

        <section className={styles.panel} aria-labelledby="editions-heading">
          <h3 id="editions-heading" className={styles.panelHeading}>Editions found · {item.candidates.length}</h3>
          {item.candidates.length > 0 && (
            <ul className={styles.editions} aria-label="Editions, best match first. Up and down arrows move the selection.">
              {item.candidates.map((c, i) => {
                const selected = i === candIdx;
                const tag = statusTag(c.status);
                const year = c.date ? c.date.slice(0, 4) : null;
                const details = [sameText(c.title, item.title) ? null : c.title, editionDetails(c)].filter(Boolean).join(' · ');
                return (
                  <li key={c.id} className={selected ? styles.editionSelected : styles.edition} onClick={() => setCandId(c.id)}>
                    <SourceIcon edition={c} />
                    <button type="button" className={styles.editionPick} aria-pressed={selected} onClick={(e) => { e.stopPropagation(); setCandId(c.id); }}>
                      <span className={styles.editionHead}>
                        <span>{[year, c.country].filter(Boolean).join(' · ') || '—'}</span>
                        {tag && <StatusTag status={tag} />}
                      </span>
                      {details && <span className={styles.editionSub}>{details}</span>}
                    </button>
                    <MatchMeter percent={matchPercent(c.distance)} />
                  </li>
                );
              })}
            </ul>
          )}
          <AddEdition
            key={item.id}
            albumId={item.id}
            inputRef={pasteRef}
            onAdded={(candidateId) => {
              setCandId(candidateId);
              void refresh();
            }}
          />
        </section>
      </div>

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

      {/* Pinned: on a long queue, a scroll per decision is a scroll per album. */}
      <div className={styles.actionBar}>
        <div className={styles.actionButtons}>
          <Button type="button" onClick={() => decide('match')} disabled={!candidate}>
            Accept match
          </Button>
          <Button variant="secondary" type="button" onClick={() => decide('as-is')}>
            Keep as-is
          </Button>
          <Button variant="secondary" type="button" onClick={() => decide('ignore')}>
            Ignore album
          </Button>
        </div>
        <IconButton label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setShowHelp(true)} aria-haspopup="dialog">
          <span className={styles.helpGlyph} aria-hidden="true">?</span>
        </IconButton>
      </div>

      {showHelp && <ShortcutsSheet onClose={() => setShowHelp(false)} />}
      {showRules && rulesView.data && libraryId && (
        <AutoAcceptDialog libraryId={libraryId} view={rulesView.data} onClose={() => setShowRules(false)} />
      )}
    </div>
  );
}

/**
 * "Not listed?": paste a MusicBrainz or Discogs link (or a release ID). The
 * worker fetches and scores the release like any candidate; the screen waits
 * for it and selects it when it arrives.
 */
function AddEdition({ albumId, inputRef, onAdded }: {
  albumId: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onAdded: (candidateId: string) => void;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // StrictMode mounts twice: the first cleanup must not stick
    return () => { alive.current = false; };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNote(null);
    if (!input.trim()) {
      setError('Paste a MusicBrainz or Discogs release link, or a release ID.');
      return;
    }
    setBusy(true);
    try {
      const { jobId } = await api.post<{ jobId: string }>(`/albums/${albumId}/editions`, { input });
      const until = Date.now() + ADD_TIMEOUT_MS;
      let result: AddResult | null = null;
      while (alive.current && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        const res = await api.get<{ state: 'pending' | 'done'; result?: AddResult }>(`/albums/${albumId}/editions/${jobId}`);
        if (res.state === 'done') { result = res.result ?? null; break; }
      }
      if (!alive.current) return;
      if (!result) {
        setError('Still waiting for MusicBrainz or Discogs. The edition appears here once the lookup finishes.');
      } else if (!result.ok) {
        setError(result.message);
      } else {
        setInput('');
        setNote(result.added ? 'Added and selected.' : 'Already listed; selected.');
        onAdded(result.candidateId);
      }
    } catch (err) {
      if (alive.current) setError((err as { detail?: string }).detail ?? 'Could not add that edition.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <form className={styles.add} onSubmit={(e) => void submit(e)} noValidate>
      <label htmlFor={`paste-${albumId}`} className={styles.addLabel}>
        Not listed? Paste a MusicBrainz or Discogs link, or a release ID
      </label>
      <div className={styles.addRow}>
        <Input
          ref={inputRef}
          id={`paste-${albumId}`}
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(null); }}
          placeholder="musicbrainz.org/release/… or discogs.com/release/…"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={error || note ? `paste-${albumId}-msg` : undefined}
          onKeyDown={(e) => { if (e.key === 'Escape') (e.target as HTMLInputElement).blur(); }}
        />
        <Button type="submit" variant="secondary" loading={busy}>Add</Button>
      </div>
      <p id={`paste-${albumId}-msg`} className={error ? styles.addError : styles.addNote} aria-live="polite">
        {error ?? (busy ? 'Looking it up…' : note)}
      </p>
    </form>
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
