/**
 * Work page: review, identify, attention and tasks tabs
 * Combines QueuePage (review), IdentifyPage (identify), AttentionPage
 * (attention) and TasksPage (tasks: gaps the owner took on, 0032)
 */
import { useMemo } from 'react';
import { useSearch, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCurrentLibrary, useIdentifyStats, useGapCounts } from '../hooks';
import { api } from '../services/api';
import { PageShell, TabItem } from '../components/ui';
import { ReviewPanel } from './QueuePage';
import { IdentifyPanel } from './IdentifyPage';
import { AttentionPanel } from './AttentionPage';
import { TasksPanel } from './TasksPage';

interface QueueData {
  items: unknown[];
  total?: number;
}

export function WorkPage() {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const { tab } = useSearch({ strict: false }) as { tab?: string };
  const activeTab = tab || 'review';

  // Fetch queue length for review tab count
  const { data: queueData } = useQuery({
    queryKey: ['queue', libraryId],
    queryFn: () =>
      api.get<QueueData>(`/libraries/${libraryId}/queue?limit=1`),
    enabled: !!libraryId,
  });

  // Fetch identify stats for identify tab count
  const { data: stats } = useIdentifyStats(libraryId);

  // Open gaps for the attention tab count, open tasks for the tasks tab
  const { data: gapsData } = useGapCounts(libraryId);
  const taskCount = gapsData?.tasks?.todo ?? 0;

  const queueCount = queueData?.total ?? 0;
  const needsReviewCount = stats?.states.needsReview ?? 0;
  const attentionTotal = useMemo(() => {
    const c = gapsData?.counts;
    if (!c) return 0;
    return (c['incomplete_album'] ?? 0) + (c['duplicate'] ?? 0) + (c['missing_album'] ?? 0);
  }, [gapsData]);

  const tabs: TabItem[] = useMemo(
    () => [
      {
        label: 'Review matches',
        value: 'review',
        ...(queueCount > 0 && { count: queueCount }),
      },
      {
        label: 'Identify albums',
        value: 'identify',
        ...(needsReviewCount > 0 && { count: needsReviewCount }),
      },
      {
        label: 'Resolve gaps',
        value: 'attention',
        ...(attentionTotal > 0 && { count: attentionTotal }),
      },
      {
        label: 'Tasks',
        value: 'tasks',
        ...(taskCount > 0 && { count: taskCount }),
      },
    ],
    [queueCount, needsReviewCount, attentionTotal, taskCount],
  );

  const handleTabChange = (newTab: string) => {
    navigate({ to: '/work', search: { tab: newTab as 'review' | 'identify' | 'attention' | 'tasks' } });
  };

  const renderPanel = () => {
    switch (activeTab) {
      case 'identify':
        return <IdentifyPanel />;
      case 'attention':
        return <AttentionPanel />;
      case 'tasks':
        return <TasksPanel />;
      default:
        return <ReviewPanel />;
    }
  };

  return (
    <PageShell
      title="Library care"
      subtitle="Find the right matches. Fill the gaps. Keep your collection in good shape."
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={handleTabChange}
    >
      {renderPanel()}
    </PageShell>
  );
}
