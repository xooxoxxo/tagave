/**
 * Library care (/work): the tabs that look after the library, from review
 * matches to Genre mapping and Background activity (spec §4), with
 * Maintenance in the header. Which tabs a person sees, and where a link to a
 * module that is off goes, is workTabs.ts; this page renders the panel.
 */
import { useMemo } from 'react';
import { Navigate, useSearch, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCan, useCurrentLibrary, useIdentifyStats, useGapCounts } from '../hooks';
import { DeletingPanel } from './DeletingPage';
import { MovedPanel } from './MovedPage';
import { OrganizePanel } from './OrganizePage';
import { InboxPanel } from './InboxPage';
import { useInbox } from '../hooks/useNaming';
import { GettingPanel } from './GettingPage';
import { useFacets } from '../hooks/useFacets';
import { api } from '../services/api';
import { PageShell, TabItem } from '../components/ui';
import { ReviewPanel } from './QueuePage';
import { IdentifyPanel } from './IdentifyPage';
import { AttentionPanel } from './AttentionPage';
import { TasksPanel } from './TasksPage';
import { AutotaggerPanel } from './review/AutotaggerPanel';
import { SettingsGenresContent } from './SettingsGenresPage';
import { JobsPage } from './JobsPage';
import { MaintenanceControl } from '../components/MaintenanceControl';
import { identifyTodoCount } from './identifyCounts';
import { allowedTab, workModules, workTabGate, workTabs, type WorkTab } from './workTabs';

interface QueueData {
  items: unknown[];
  total?: number;
}

export function WorkPage() {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const tab = typeof search['tab'] === 'string' ? search['tab'] : undefined;
  const owner = useCan('system.manage');
  const editor = useCan('library.edit');
  // Getting and Autotagger show while their module is on (workTabs.ts)
  // GET /facets failed: every module counts as off, so the gate still redirects
  const facets = useFacets();
  const modules = workModules(facets.data?.modules, facets.isError);
  const lidarrOn = modules['lidarr'] ?? null;
  const autotaggerOn = modules['autotagger'] ?? null;

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
    () => workTabs({
      owner,
      editor,
      lidarrOn,
      autotaggerOn,
      counts: { queue: queueCount, identify: identifyCount, attention: attentionTotal, tasks: taskCount, inbox: inboxCount },
    }),
    [owner, editor, lidarrOn, autotaggerOn, queueCount, identifyCount, attentionTotal, taskCount, inboxCount],
  );

  const handleTabChange = (newTab: string) => {
    navigate({ to: '/work', search: { tab: newTab as WorkTab } });
  };

  // a tab mapped to a module that is off goes elsewhere (the modules rule)
  const gate = workTabGate({ tab, search, owner, modules });
  if (gate && 'to' in gate) return <Navigate to={gate.to as never} search={gate.search as never} replace />;
  const activeTab = gate ? (tab as WorkTab) : allowedTab(tab, tabs);

  const renderPanel = () => {
    // the module's state is still loading: hold the tab's place, never another tab
    if (gate) return null;
    switch (activeTab) {
      case 'identify':
        return <IdentifyPanel />;
      case 'attention':
        return <AttentionPanel />;
      case 'tasks':
        return <TasksPanel />;
      case 'deleting':
        return <DeletingPanel />;
      case 'moved':
        return <MovedPanel />;
      case 'organize':
        return <OrganizePanel />;
      case 'inbox':
        return <InboxPanel />;
      case 'getting':
        return <GettingPanel />;
      case 'autotagger':
        return <AutotaggerPanel />;
      case 'genres':
        return <SettingsGenresContent />;
      case 'activity':
        return <JobsPage />;
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
      actions={<MaintenanceControl />}
    >
      {renderPanel()}
    </PageShell>
  );
}
