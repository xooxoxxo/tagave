/**
 * Identification (XO-309): where every album stands, what is still waiting
 * and the albums that could not be matched, with what to do about them.
 * When nothing is pending the page says so plainly: no rate, no ETA, no
 * sweep button — the sweep runs by itself every five minutes.
 */
import { useState, useMemo, useEffect } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCurrentLibrary, useIdentifyStats, useIdentifyTriage, useRetryIdentify, useKickSweep, useIdentifyRequests, useCancelIdentifyRequest } from '../hooks';
import { formatEta, formatRelativeTime } from '../utils/time';
import { Button } from '../components/ui';
import styles from './IdentifyPage.module.css';

const REASON_LABEL: Record<string, string> = {
  no_tags: 'no tags',
  no_candidates: 'no candidates',
  weak_candidates: 'weak candidates',
  ambiguous: 'ambiguous',
  provider_errors: 'provider errors',
  job_failed: 'job failed',
  unknown: 'unknown',
};

const REASONS = [
  { key: null, label: 'All' },
  { key: 'no_tags', label: 'No tags' },
  { key: 'no_candidates', label: 'No candidates' },
  { key: 'weak_candidates', label: 'Weak candidates' },
  { key: 'provider_errors', label: 'Provider errors' },
  { key: 'job_failed', label: 'Failed jobs' },
];

export function IdentifyPanel() {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const [reason, setReason] = useState<string | null>(null);
  const [searchQ, setSearchQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);

  // 300 ms trailing debounce so typing does not fire a request per key
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchQ.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQ]);

  const { data: stats, isLoading: statsLoading } = useIdentifyStats(libraryId);
  const { data: triage, isLoading: triageLoading } = useIdentifyTriage(libraryId, {
    reason: reason || undefined,
    q: debouncedQ || undefined,
    limit: 100,
    offset: page * 100,
  });
  const retry = useRetryIdentify(libraryId);
  const kickSweep = useKickSweep(libraryId);
  const { data: requests } = useIdentifyRequests(libraryId);
  const cancelRequest = useCancelIdentifyRequest(libraryId);
  const REQUEST_KIND: Record<string, string> = { mbid: 'MusicBrainz id', discogs: 'Discogs id', reidentify: 'Re-identify', sweep: 'Sweep' };

  const limit = 100;
  const offset = page * 100;

  const reasonCounts = useMemo(() => {
    if (!stats) return {};
    return {
      no_tags: stats.reasons?.['no_tags'] ?? 0,
      no_candidates: stats.reasons?.['no_candidates'] ?? 0,
      weak_candidates: stats.reasons?.['weak_candidates'] ?? 0,
      provider_errors: stats.reasons?.['provider_errors'] ?? 0,
      job_failed: stats.reasons?.['job_failed'] ?? 0,
    };
  }, [stats]);

  const handleRetryReason = () => {
    if (!reason) return;
    retry.mutate({ reason });
    setSelectedIds(new Set());
  };

  const handleRetrySelected = () => {
    if (selectedIds.size === 0) return;
    retry.mutate({ albumIds: Array.from(selectedIds) });
    setSelectedIds(new Set());
  };

  const handleToggleAll = (checked: boolean) => {
    if (checked && triage) {
      setSelectedIds(new Set(triage.items.map((item) => item.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  if (!libraryId) {
    return <div className={styles.container}>Loading...</div>;
  }

  if (statsLoading && !stats) {
    return <div className={styles.container}>Loading identification stats...</div>;
  }

  if (!stats) {
    return <div className={styles.container}>Failed to load stats</div>;
  }

  const total = stats.total;
  const matched = stats.states.matched;
  const share = (stats.identifiedShare * 100).toFixed(1);
  const waiting = stats.states.pending;
  const perMin = stats.rate.perMin;
  const queue = stats.queue;
  const settled = waiting === 0;
  // Rate and ETA only mean something while albums wait; the rate counts
  // albums decided in the last 15 minutes.
  const progressLine = perMin > 0 && stats.etaSeconds
    ? `About ${perMin.toLocaleString()} a minute · done in ${formatEta(stats.etaSeconds)}`
    : queue.active > 0
      ? 'Working on them now; the pace shows after a few minutes.'
      : 'Waiting for the worker to pick them up.';
  const scrollToUnmatched = () => document.getElementById('could-not-match')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Provenance of the live matches + the embedded-MBID fast path (XO-309).
  // Both fields are absent on an older API during a rolling deploy.
  const sources = stats.sources ?? {};
  const fastPath = stats.fastPath ?? { eligible: 0, viaMbid: 0, viaOther: 0, undecided: 0, pending: 0 };
  const buckets = [
    { key: 'mbid', label: 'Embedded MBID', count: sources['mbid'] ?? 0, className: styles.srcMbid },
    { key: 'mb_search', label: 'MusicBrainz search', count: sources['mb_search'] ?? 0, className: styles.srcMbSearch },
    { key: 'discogs_search', label: 'Discogs', count: sources['discogs_search'] ?? 0, className: styles.srcDiscogs },
    { key: 'manual', label: 'Manual', count: (sources['user_mbid'] ?? 0) + (sources['user_discogs'] ?? 0), className: styles.srcManual },
    { key: 'unknown', label: 'Unknown', count: sources['unknown'] ?? 0, className: styles.srcUnknown },
  ];
  const liveTotal = buckets.reduce((n, b) => n + b.count, 0);
  const pctOf = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '0%');

  return (
    <div className={styles.container}>
      <header className={styles.header}>

        {/* One figure, the three decisions as links, then what is going on now */}
        <div className={styles.headerStrip}>
          <div className={styles.identified}>
            <div className={styles.identifiedPercent}>{share}%</div>
            <div className={styles.identifiedLabel}>identified</div>
            <div className={styles.identifiedNote}>{matched.toLocaleString()} of {total.toLocaleString()} albums</div>
          </div>

          <nav className={styles.decisions} aria-label="Albums by decision">
            <Link className={styles.decision} to="/albums" search={{ state: ['matched'] } as never}>
              <span className={styles.statValue}>{matched.toLocaleString()}</span>
              <span className={styles.statLabel}>Matched</span>
            </Link>
            <Link className={styles.decision} to="/work" search={{ tab: 'review' } as never}>
              <span className={styles.statValue}>{stats.states.needsReview.toLocaleString()}</span>
              <span className={styles.statLabel}>Need your review</span>
            </Link>
            <button type="button" className={styles.decision} onClick={scrollToUnmatched}>
              <span className={styles.statValue}>{stats.states.unidentified.toLocaleString()}</span>
              <span className={styles.statLabel}>Could not be matched</span>
            </button>
          </nav>
        </div>

        {settled ? (
          <div className={styles.statusLine} role="status">
            <span className={styles.statusDot} data-tone="ok" aria-hidden="true" />
            <div>
              <div className={styles.statusTitle}>Every album has a decision</div>
              <div className={styles.statusNote}>
                Nothing is waiting to be identified. Albums a scan adds are picked up within five minutes.
                {requests && requests.items.length > 0 ? ` ${requests.items.length} manual ${requests.items.length === 1 ? 'request is' : 'requests are'} in the queue below.` : ''}
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.statusLine} role="status">
            <span className={styles.statusDot} data-tone="live" aria-hidden="true" />
            <div className={styles.statusBody}>
              <div className={styles.statusTitle}>{waiting.toLocaleString()} {waiting === 1 ? 'album is' : 'albums are'} waiting to be identified</div>
              <div className={styles.statusNote}>
                {progressLine} · {queue.queued.toLocaleString()} queued · {queue.active.toLocaleString()} running{queue.retry > 0 ? ` · ${queue.retry.toLocaleString()} retrying` : ''}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => kickSweep.mutate()} loading={kickSweep.isPending} title="Queue the waiting albums now instead of at the next five-minute sweep">
              Identify waiting albums now
            </Button>
          </div>
        )}

        {reason && (
          <div className={styles.headerActions}>
            <Button variant="secondary" size="sm" onClick={handleRetryReason} disabled={retry.isPending}>
              {retry.isPending ? 'Retrying...' : 'Retry all in this category'}
            </Button>
          </div>
        )}
      </header>

      {/* Manual requests: owner-initiated identify jobs still in the queue */}
      <section className={styles.requests}>
        <div className={styles.provenanceHeader}>
          <span className={styles.identifiedLabel}>Manual requests</span>
          <span className={styles.provenanceTotal}>{requests ? `${requests.items.length} queued` : '…'}</span>
        </div>
        {requests && requests.items.length === 0 && (
          <div className={styles.fastPathLine}>No manual identification requests waiting. Requests from an album page run ahead of the sweep.</div>
        )}
        {requests && requests.items.length > 0 && (
          <div className={styles.requestList}>
            {requests.items.map((r) => (
              <div key={r.id} className={styles.requestRow}>
                <button className={styles.requestAlbum} onClick={() => navigate({ to: '/albums/$albumId', params: { albumId: r.album.id } as never })}>
                  {r.album.artist ? `${r.album.artist} — ` : ''}{r.album.title ?? '(untitled)'}
                </button>
                <span className={styles.requestMeta}>
                  {REQUEST_KIND[r.kind] ?? r.kind}{r.pinned ? ` ${r.pinned}` : ''} · {r.state === 'active' ? 'running' : r.state === 'retry' ? 'retrying' : r.jobsAhead === 0 ? 'next' : `${r.jobsAhead.toLocaleString()} ahead`} · {formatRelativeTime(r.createdAt)}
                </span>
                <Button variant="secondary" size="sm" onClick={() => cancelRequest.mutate(r.album.id)} disabled={cancelRequest.isPending || r.state === 'active'}>
                  Cancel
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Provenance: how the live matches were found */}
      <section className={styles.provenance}>
        <div className={styles.provenanceHeader}>
          <span className={styles.identifiedLabel}>How albums were matched</span>
          <span className={styles.provenanceTotal}>{liveTotal} live {liveTotal === 1 ? 'match' : 'matches'}</span>
        </div>
        <div className={styles.provenanceBar} role="img" aria-label="Match sources">
          {buckets.filter((b) => b.count > 0).map((b) => (
            <div
              key={b.key}
              className={`${styles.provenanceSegment} ${b.className}`}
              style={{ flexGrow: b.count }}
              title={`${b.label}: ${b.count} (${pctOf(b.count, liveTotal)})`}
            />
          ))}
        </div>
        <div className={styles.provenanceLegend}>
          {buckets.filter((b) => b.count > 0 || b.key === 'mbid').map((b) => (
            <span key={b.key} className={styles.legendItem}>
              <span className={`${styles.legendSwatch} ${b.className}`} />
              {b.label} <strong>{b.count}</strong> <span className={styles.legendPct}>{pctOf(b.count, liveTotal)}</span>
            </span>
          ))}
        </div>
        <div className={styles.fastPathLine}>
          {fastPath.eligible === 0
            ? 'No albums carry embedded MusicBrainz IDs in their tags.'
            : `Embedded MusicBrainz IDs: ${fastPath.eligible} ${fastPath.eligible === 1 ? 'album' : 'albums'} · ${fastPath.viaMbid} matched via the tag (${pctOf(fastPath.viaMbid, fastPath.eligible)} of eligible) · ${fastPath.viaOther} via search · ${fastPath.undecided} undecided · ${fastPath.pending} pending`}
        </div>
      </section>

      {/* Could not be matched: what the owner can do next */}
      <section id="could-not-match" className={styles.nextSteps} aria-labelledby="could-not-match-title">
        <div className={styles.provenanceHeader}>
          <span id="could-not-match-title" className={styles.identifiedLabel}>Could not be matched</span>
          <span className={styles.provenanceTotal}>{stats.states.unidentified.toLocaleString()} {stats.states.unidentified === 1 ? 'album' : 'albums'}</span>
        </div>
        <p className={styles.fastPathLine}>
          Liner searched MusicBrainz and Discogs for these and found nothing close enough. Open an album from the list below and pick one:
        </p>
        <ol className={styles.stepList}>
          <li><strong>Fingerprint it.</strong> AcoustID recognises the recordings even when the tags are wrong or missing (needs an AcoustID key in <Link to="/settings/providers">Settings › Providers</Link>).</li>
          <li><strong>Match it yourself.</strong> Paste the MusicBrainz release — or its release group — or the Discogs release under <em>Manage this album</em>.</li>
          <li><strong>Set the values yourself.</strong> <em>Set album values…</em> writes the artist, title and year you give, after a preview you approve.</li>
        </ol>
      </section>

      {/* Reason tabs */}
      <div className={styles.tabs}>
        {REASONS.map((r) => (
          <button
            key={r.key || 'all'}
            className={reason === r.key ? styles.tabActive : styles.tab}
            onClick={() => {
              setReason(r.key);
              setPage(0);
              setSelectedIds(new Set());
            }}
          >
            {r.label} {reasonCounts[r.key as keyof typeof reasonCounts] ?? 0}
          </button>
        ))}
        <Button
          variant="quiet"
          size="sm"
          onClick={() => navigate({ to: '/queue' })}
        >
          Ambiguous → Queue
        </Button>
      </div>

      {/* Search */}
      <div className={styles.searchBox}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search by title or artist..."
          value={searchQ}
          onChange={(e) => {
            setSearchQ(e.target.value);
            setPage(0);
            setSelectedIds(new Set());
          }}
        />
      </div>

      {/* Triage list */}
      {triageLoading && <div className={styles.loading}>Loading items...</div>}
      {triage && triage.items.length === 0 && (
        <div className={styles.empty}>No unidentified albums in this category.</div>
      )}
      {triage && triage.items.length > 0 && (
        <>
          {/* Checkbox row */}
          <div className={styles.checkboxRow}>
            <input
              type="checkbox"
              className={styles.checkboxInput}
              checked={selectedIds.size === triage.items.length && triage.items.length > 0}
              onChange={(e) => handleToggleAll(e.target.checked)}
            />
            <span className={styles.checkboxLabel}>
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}
            </span>
            {selectedIds.size > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleRetrySelected}
                disabled={retry.isPending}
              >
                {retry.isPending ? 'Retrying...' : 'Retry selected'}
              </Button>
            )}
          </div>

          {/* Items */}
          <div className={styles.itemsList}>
            {triage.items.map((item) => (
              <div key={item.id} className={styles.item}>
                <div className={styles.itemCheckbox}>
                  <input
                    type="checkbox"
                    className={styles.checkboxInput}
                    checked={selectedIds.has(item.id)}
                    onChange={(e) => {
                      const newIds = new Set(selectedIds);
                      if (e.target.checked) {
                        newIds.add(item.id);
                      } else {
                        newIds.delete(item.id);
                      }
                      setSelectedIds(newIds);
                    }}
                  />
                </div>

                <div
                  className={styles.itemMain}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate({ to: '/albums/$albumId', params: { albumId: item.id } as never })}
                >
                  <div className={styles.itemTitle}>
                    {item.artist ? `${item.artist} — ` : ''}{item.title ?? '(untitled)'}{item.year ? ` (${item.year})` : ''}
                  </div>
                  <div className={styles.itemSecondary}>
                    {item.trackCount} tracks · {item.formats.join(', ')}{item.dirPath ? ` · ${item.dirPath}` : ''}
                  </div>
                </div>

                <div className={styles.itemRight}>
                  <div className={styles.itemReason}>{REASON_LABEL[item.reason] ?? item.reason}</div>
                  {item.best && (
                    <div className={styles.itemBest}>
                      best: {item.best.title} ({item.best.distance.toFixed(2)}, {item.best.source})
                    </div>
                  )}
                  {item.error && (
                    <div className={styles.itemError} title={item.error}>
                      {item.error.length > 60 ? `${item.error.slice(0, 60)}…` : item.error}
                    </div>
                  )}
                  <div className={styles.itemMeta}>
                    {item.attempts} {item.attempts === 1 ? 'attempt' : 'attempts'} · {item.lastIdentifyAt ? formatRelativeTime(item.lastIdentifyAt) : 'never run'}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          <div className={styles.pagination}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(page - 1)}
              disabled={page === 0 || triageLoading}
            >
              Prev
            </Button>
            <span className={styles.pageInfo}>
              {offset + 1}–{Math.min(offset + limit, triage.total ?? 0)} of {triage.total ?? 0}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(page + 1)}
              disabled={!triage.total || offset + limit >= triage.total || triageLoading}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// Legacy export for backwards compatibility
export function IdentifyPage() {
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h1 className={styles.title}>Identification</h1>
        </div>
      </header>
      <IdentifyPanel />
    </div>
  );
}
