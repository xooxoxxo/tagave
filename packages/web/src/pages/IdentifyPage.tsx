/**
 * Identification triage page (XO-309): stats, trends, triage list, sweep controls
 */
import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useCurrentLibrary, useIdentifyStats, useIdentifyTriage, useRetryIdentify, useKickSweep, useIdentifyRequests, useCancelIdentifyRequest } from '../hooks';
import { formatEta, formatRelativeTime } from '../utils/time';
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
  const target = stats.target;
  const day = target.day;
  const deadline = new Date(target.deadline).toLocaleDateString();
  const onTrack = target.onTrack ? 'on track' : 'behind';
  const perMin = stats.rate.perMin;
  const perHour = stats.rate.perHour;
  const eta = formatEta(stats.etaSeconds);
  const queue = stats.queue;
  const series = stats.series;

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

        {/* Header strip with big % and stats */}
        <div className={styles.headerStrip}>
          <div className={styles.identified}>
            <div className={styles.identifiedPercent}>{share}%</div>
            <div className={styles.identifiedLabel}>identified</div>
            <div className={styles.identifiedNote}>{matched} of {total}</div>
          </div>

          <div className={styles.stats}>
            <div className={styles.statBlock}>
              <div className={styles.statValue}>{stats.states.needsReview}</div>
              <div className={styles.statLabel}>needs review</div>
            </div>
            <div className={styles.statBlock}>
              <div className={styles.statValue}>{stats.states.pending}</div>
              <div className={styles.statLabel}>pending</div>
            </div>
            <div className={styles.statBlock}>
              <div className={styles.statValue}>{stats.states.unidentified}</div>
              <div className={styles.statLabel}>unidentified</div>
            </div>
          </div>
        </div>

        {/* G1 line: day, target, required */}
        <div className={styles.g1Line}>
          <div className={styles.g1Text}>
            Day {day} of 30 · target 95% by {deadline} · need {target.requiredPerDay}/day, {target.matched24h} in the last 24 h
          </div>
          <div className={`${styles.badge} ${onTrack === 'on track' ? styles.badgeOnTrack : styles.badgeBehind}`}>
            {onTrack}
          </div>
        </div>

        {/* Rate and ETA */}
        <div className={styles.rateEta}>
          <span className={styles.rate}>{perMin}/min · ETA {eta}</span>
          <span className={styles.queueDepth}>
            {queue.queued} queued · {queue.active} active · {queue.retry} retrying · {queue.failed} failed
          </span>
        </div>

        {/* Buttons */}
        <div className={styles.headerActions}>
          <button
            className={styles.btn}
            onClick={() => kickSweep.mutate()}
            disabled={kickSweep.isPending}
          >
            {kickSweep.isPending ? 'Kicking...' : 'Kick sweep'}
          </button>
          {reason && (
            <button
              className={styles.btn}
              onClick={handleRetryReason}
              disabled={retry.isPending}
            >
              {retry.isPending ? 'Retrying...' : `Retry all in this category`}
            </button>
          )}
        </div>
      </header>

      {/* 30-day sparkline */}
      <div className={styles.sparklineContainer}>
        <svg className={styles.sparkline} viewBox="0 0 300 60" preserveAspectRatio="none">
          {/* 95% line */}
          <line x1="0" y1={60 * (1 - 0.95)} x2="300" y2={60 * (1 - 0.95)} stroke="currentColor" strokeWidth="1" strokeDasharray="2,2" opacity="0.5" />
          {/* polyline for cumulative share */}
          {series && series.length > 0 && (
            <polyline
              points={series
                .map((d, i) => `${(i / (series.length - 1)) * 300},${60 * (1 - d.cumulativeShare)}`)
                .join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
          )}
        </svg>
      </div>

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
                <button className={styles.btn} onClick={() => cancelRequest.mutate(r.album.id)} disabled={cancelRequest.isPending || r.state === 'active'}>
                  Cancel
                </button>
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
        <button
          className={styles.tabLink}
          onClick={() => navigate({ to: '/queue' })}
        >
          Ambiguous → Queue
        </button>
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
              <button
                className={styles.btn}
                onClick={handleRetrySelected}
                disabled={retry.isPending}
              >
                {retry.isPending ? 'Retrying...' : 'Retry selected'}
              </button>
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
            <button
              className={styles.btn}
              onClick={() => setPage(page - 1)}
              disabled={page === 0 || triageLoading}
            >
              Prev
            </button>
            <span className={styles.pageInfo}>
              {offset + 1}–{Math.min(offset + limit, triage.total ?? 0)} of {triage.total ?? 0}
            </span>
            <button
              className={styles.btn}
              onClick={() => setPage(page + 1)}
              disabled={!triage.total || offset + limit >= triage.total || triageLoading}
            >
              Next
            </button>
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
