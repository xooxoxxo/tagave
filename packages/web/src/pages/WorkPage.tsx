/**
 * Work page: review, identify, attention and tasks tabs
 * Combines QueuePage (review), IdentifyPage (identify), AttentionPage
 * (attention) and TasksPage (tasks: gaps the owner took on, 0032)
 */
import { useMemo } from 'react';
import { useSearch, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCan, useCurrentLibrary, useIdentifyStats, useGapCounts } from '../hooks';
import { DeletingPanel } from './DeletingPage';
import { MovedPanel } from './MovedPage';
import { OrganizePanel } from './OrganizePage';
import { InboxPanel } from './InboxPage';
import { useInbox } from '../hooks/useNaming';
import { GettingPanel } from './GettingPage';
import { useModuleOn } from '../hooks/useFacets';
import { api } from '../services/api';
import { PageShell, TabItem } from '../components/ui';
import { ReviewPanel } from './QueuePage';
import { IdentifyPanel } from './IdentifyPage';
import { AttentionPanel } from './AttentionPage';
import { TasksPanel } from './TasksPage';
import { identifyTodoCount } from './identifyCounts';

interface QueueData {
  items: unknown[];
  total?: number;
}

export function WorkPage() {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const { tab } = useSearch({ strict: false }) as { tab?: string };
  const owner = useCan('system.manage');
  // albums asked of Lidarr: the owner's, while the lidarr module is on
  const lidarrOn = useModuleOn('lidarr');
  const getting = owner && lidarrOn === true;
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

  // dropped albums waiting for the owner (the drop pool, 0081)
  const { data: inboxData } = useInbox(owner ? libraryId : undefined);
  const inboxCount = inboxData?.items.filter((i) => i.state === 'inbox').length ?? 0;

  const queueCount = queueData?.total ?? 0;
  const identifyCount = identifyTodoCount(stats) ?? 0;
  const attentionTotal = useMemo(() => {
    const c = gapsData?.counts;
    if (!c) return 0;
    return (c['incomplete_album'] ?? 0) + (c['duplicate'] ?? 0) + (c['missing_album'] ?? 0) + (c['one_file_album'] ?? 0);
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
        ...(identifyCount > 0 && { count: identifyCount }),
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
      // deleted songs and albums: the owner's (a deletion reaches the music folder)
      ...(owner ? [{ label: 'Deleting', value: 'deleting' }] : []),
      // songs moved to another album (Maintenance › Move to album): the owner's
      ...(owner ? [{ label: 'Moved', value: 'moved' }] : []),
      // albums whose paths differ from the naming rules, and the drop pool's Inbox (0081)
      ...(owner ? [{ label: 'Organize', value: 'organize' }] : []),
      ...(owner ? [{ label: 'Inbox', value: 'inbox', ...(inboxCount > 0 && { count: inboxCount }) }] : []),
      ...(getting ? [{ label: 'Getting', value: 'getting' }] : []),
    ],
    [queueCount, identifyCount, attentionTotal, taskCount, owner, getting, inboxCount],
  );

  const handleTabChange = (newTab: string) => {
    navigate({ to: '/work', search: { tab: newTab as 'review' | 'identify' | 'attention' | 'tasks' | 'deleting' | 'moved' | 'organize' | 'inbox' | 'getting' } });
  };

  const renderPanel = () => {
    switch (activeTab) {
      case 'identify':
        return <IdentifyPanel />;
      case 'attention':
        return <AttentionPanel />;
      case 'tasks':
        return <TasksPanel />;
      case 'deleting':
        return owner ? <DeletingPanel /> : <ReviewPanel />;
      case 'moved':
        return owner ? <MovedPanel /> : <ReviewPanel />;
      case 'organize':
        return owner ? <OrganizePanel /> : <ReviewPanel />;
      case 'inbox':
        return owner ? <InboxPanel /> : <ReviewPanel />;
      case 'getting':
        return getting ? <GettingPanel /> : <ReviewPanel />;
      default:
        return <ReviewPanel />;
    }
  };

  return (
    <PageShell
      title="Library care"
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={handleTabChange}
    >
      {renderPanel()}
    </PageShell>
  );
}
