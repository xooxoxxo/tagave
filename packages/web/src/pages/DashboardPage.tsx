/**
 * Home page (DashboardPage) showing library overview and priority actions
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCurrentLibrary, useIdentifyStats, useTagPlans } from '../hooks';
import { api } from '../services/api';
import { PageShell, StatCard, Card } from '../components/ui';
import styles from './DashboardPage.module.css';

interface GapsCounts {
  counts: Record<string, number>;
}

interface QueueResponse {
  items: unknown[];
  nextCursor: string | null;
  total?: number;
}

interface LibraryAlbums {
  items: unknown[];
  nextCursor: string | null;
  total?: number;
}

function useGapsCounts(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['gaps-counts', libraryId],
    queryFn: () =>
      api.get<GapsCounts>(`/libraries/${libraryId}/gaps?limit=1`),
    enabled: !!libraryId,
    staleTime: 1000 * 60, // 1 minute
  });
}

function useQueueTotal(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['queue-total', libraryId],
    queryFn: () =>
      api.get<QueueResponse>(`/libraries/${libraryId}/queue?limit=1`),
    enabled: !!libraryId,
    staleTime: 1000 * 60, // 1 minute
  });
}

function useLibraryAlbumTotal(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['library-albums-total', libraryId],
    queryFn: () =>
      api.get<LibraryAlbums>(`/libraries/${libraryId}/albums?limit=1`),
    enabled: !!libraryId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function DashboardPage() {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const { data: identifyStats } = useIdentifyStats(libraryId);
  const { data: gapsCounts } = useGapsCounts(libraryId);
  const { data: queueData } = useQueueTotal(libraryId);
  const { data: albumsData } = useLibraryAlbumTotal(libraryId);
  const { data: tagPlans } = useTagPlans(libraryId, { limit: 5 });

  if (!libraryId) {
    return <PageShell title="Home">Loading library...</PageShell>;
  }

  // Calculate metrics
  const identifiedShare = identifyStats ? (identifyStats.identifiedShare * 100).toFixed(1) : '—';
  const gaps = gapsCounts?.counts ?? {};
  // Open gaps are the collection kinds; quality flags are tag/art hygiene and
  // feed Tag health instead.
  const totalGaps = (gaps['incomplete_album'] ?? 0) + (gaps['duplicate'] ?? 0) + (gaps['missing_album'] ?? 0);
  const queueTotal = queueData?.total ?? 0;
  const totalAlbums = identifyStats?.total ?? albumsData?.total ?? 0;
  const albumsWithoutGaps = Math.max(0, totalAlbums - (gaps['quality'] ?? 0));
  const tagHealth = totalAlbums > 0 ? ((albumsWithoutGaps / totalAlbums) * 100).toFixed(1) : '—';

  // Build "Needs You" shortcuts from counts
  const needsYouItems: Array<{ label: string; count: number; tab: 'review' | 'identify' | 'attention' }> = [];
  if (gaps.duplicate) {
    needsYouItems.push({
      label: 'duplicate groups to resolve',
      count: gaps.duplicate,
      tab: 'attention',
    });
  }
  if (gaps.incomplete_album) {
    needsYouItems.push({
      label: 'incomplete albums to complete',
      count: gaps.incomplete_album,
      tab: 'attention',
    });
  }
  if (gaps.missing_album) {
    needsYouItems.push({
      label: 'missing albums to track',
      count: gaps.missing_album,
      tab: 'attention',
    });
  }
  if (gaps.quality) {
    needsYouItems.push({
      label: 'albums with tag or art flags',
      count: gaps.quality,
      tab: 'attention',
    });
  }
  if (queueTotal > 0) {
    needsYouItems.push({
      label: 'albums waiting for review',
      count: queueTotal,
      tab: 'review',
    });
  }

  const recentPlans = tagPlans?.items.slice(0, 5) ?? [];

  const handleNavToWork = (tab: 'review' | 'identify' | 'attention') => {
    navigate({ to: '/work', search: { tab } });
  };

  return (
    <PageShell title="Home" subtitle="Library metrics and priority actions">
      <div className={styles.content}>
        {/* Four stat cards grid */}
        <div className={styles.statsGrid}>
          <button
            className={styles.cardButton}
            onClick={() => handleNavToWork('review')}
          >
            <StatCard
              label="Identified"
              value={`${identifiedShare}%`}
              hint={
                identifyStats
                  ? `${identifyStats.states.matched} of ${identifyStats.total} albums`
                  : undefined
              }
              tone="info"
            />
          </button>

          <Link to="/albums">
            <StatCard
              label="Tag Health"
              value={`${tagHealth}%`}
              hint={`${albumsWithoutGaps} of ${totalAlbums} albums`}
              tone="success"
            />
          </Link>

          <button
            className={styles.cardButton}
            onClick={() => handleNavToWork('attention')}
          >
            <StatCard
              label="Open Gaps"
              value={totalGaps.toString()}
              hint={`${gaps.duplicate || 0} duplicates · ${gaps.incomplete_album || 0} incomplete`}
              tone="warning"
            />
          </button>

          <button
            className={styles.cardButton}
            onClick={() => handleNavToWork('review')}
          >
            <StatCard
              label="Review Items"
              value={queueTotal.toString()}
              hint="albums waiting for review"
              tone="info"
            />
          </button>
        </div>

        {/* Needs You section */}
        {needsYouItems.length > 0 && (
          <Card title="Needs You" padded={false}>
            <div className={styles.needsList}>
              {needsYouItems.slice(0, 5).map((item, idx) => (
                <button
                  key={idx}
                  className={styles.needsItem}
                  onClick={() => handleNavToWork(item.tab)}
                >
                  <span className={styles.needsCount}>{item.count}</span>
                  <span className={styles.needsLabel}>{item.label}</span>
                </button>
              ))}
            </div>
          </Card>
        )}

        {/* Recent Plans section */}
        {recentPlans.length > 0 && (
          <Card title="Recent Plans" padded={false}>
            <div className={styles.plansList}>
              {recentPlans.map((plan) => (
                <Link
                  key={plan.id}
                  to="/plans/$planId"
                  params={{ planId: plan.id }}
                  className={styles.planItem}
                >
                  <span className={styles.planName}>{plan.name}</span>
                  <span className={styles.planState}>{plan.status.replace(/_/g, ' ')}</span>
                </Link>
              ))}
            </div>
          </Card>
        )}
      </div>
    </PageShell>
  );
}
