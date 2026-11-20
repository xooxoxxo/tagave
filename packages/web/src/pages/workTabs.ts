/**
 * Library care's tabs (spec §4), as plain data: which tabs a person sees, the
 * tab an address may open, and where a link to a module that is off goes.
 * The router imports this file (parseWorkSearch), never WorkPage.tsx, so the
 * page stays its own chunk.
 *
 * The modules rule: a tab mapped to a module shows only while the module is
 * on, for everyone, the owner included. A link to it while the module is off
 * takes the owner to Settings › Modules and anyone else to Review matches.
 */
import type { TabItem } from '../components/ui/Tabs';

export const WORK_TABS = ['review', 'identify', 'attention', 'tasks', 'deleting', 'moved', 'organize', 'inbox', 'getting', 'autotagger', 'genres', 'activity'] as const;
export type WorkTab = (typeof WORK_TABS)[number];

const isWorkTab = (tab: string): tab is WorkTab => (WORK_TABS as readonly string[]).includes(tab);

/** `/work`'s search: an unknown tab throws; `?job=` (Background activity) kept when given. */
export function parseWorkSearch(search: Record<string, unknown>): { tab: WorkTab; job?: string } {
  const tab = search['tab'] as string | undefined;
  if (tab && !isWorkTab(tab)) throw new Error(`Invalid work tab: ${tab}`);
  const job = search['job'];
  return { tab: (tab as WorkTab | undefined) ?? 'review', ...(typeof job === 'string' && job && { job }) };
}

export interface WorkTabsInput {
  owner: boolean;
  editor: boolean;
  lidarrOn: boolean | null;
  autotaggerOn: boolean | null;
  counts: { queue: number; identify: number; attention: number; tasks: number; inbox: number };
}

const counted = (n: number) => (n > 0 ? { count: n } : {});

/** The tabs this person sees, in order; a count only when there is one. */
export function workTabs({ owner, editor, lidarrOn, autotaggerOn, counts }: WorkTabsInput): TabItem[] {
  return [
    { label: 'Review matches', value: 'review', ...counted(counts.queue) },
    { label: 'Identify albums', value: 'identify', ...counted(counts.identify) },
    { label: 'Resolve gaps', value: 'attention', ...counted(counts.attention) },
    { label: 'Tasks', value: 'tasks', ...counted(counts.tasks) },
    // deleted songs and albums: the owner's (a deletion reaches the music folder)
    ...(owner ? [{ label: 'Deleting', value: 'deleting' }] : []),
    // songs moved to another album (Maintenance › Move to album): the owner's
    ...(owner ? [{ label: 'Moved', value: 'moved' }] : []),
    // albums whose paths differ from the naming rules, and the drop pool's Inbox (0081)
    ...(owner ? [{ label: 'Organize', value: 'organize' }] : []),
    ...(owner ? [{ label: 'Inbox', value: 'inbox', ...counted(counts.inbox) }] : []),
    // albums asked of Lidarr: the owner's, while the lidarr module is on
    ...(owner && lidarrOn === true ? [{ label: 'Getting', value: 'getting' }] : []),
    // the autotagger: anyone who may edit the library, while the module is on
    ...(editor && autotaggerOn === true ? [{ label: 'Autotagger', value: 'autotagger' }] : []),
    ...(editor ? [{ label: 'Genre mapping', value: 'genres' }, { label: 'Background activity', value: 'activity' }] : []),
  ];
}

/** The tab to open: the one asked for when the person has it, else Review matches. */
export function allowedTab(tab: string | undefined, tabs: TabItem[]): WorkTab {
  return tab && isWorkTab(tab) && tabs.some((t) => t.value === tab) ? tab : 'review';
}

/** A tab mapped to a module (by facet id). */
export const TAB_MODULE: Readonly<Partial<Record<WorkTab, string>>> = { autotagger: 'autotagger', getting: 'lidarr' };

/**
 * The state of each tab's module from GET /facets (facet id → on; null while
 * it loads). A failed GET counts every module as off, so a link to a module's
 * tab still goes somewhere rather than waiting on an empty page.
 */
export function workModules(
  modules: ReadonlyArray<{ id: string; enabled: boolean }> | undefined,
  failed: boolean,
): Record<string, boolean | null> {
  return Object.fromEntries(Object.values(TAB_MODULE).map((id) => {
    const m = modules?.find((x) => x.id === id);
    return [id, m ? m.enabled : modules || failed ? false : null];
  }));
}

export type WorkTabGate = { wait: true } | { to: '/settings/modules' | '/work'; search: Record<string, unknown> } | null;

/**
 * A tab whose module is off: the owner to Settings › Modules, anyone else to
 * Review matches with every other parameter kept. While the module's state
 * loads (null) the page holds the tab's place. Null: open the tab as usual.
 */
export function workTabGate({ tab, search, owner, modules }: {
  tab: string | undefined;
  search: Record<string, unknown>;
  owner: boolean;
  modules: Readonly<Record<string, boolean | null>>;
}): WorkTabGate {
  const facet = tab && isWorkTab(tab) ? TAB_MODULE[tab] : undefined;
  if (!facet) return null;
  const on = modules[facet] ?? null;
  if (on === null) return { wait: true };
  if (on) return null;
  if (owner) return { to: '/settings/modules', search: {} };
  const { tab: _tab, ...rest } = search;
  return { to: '/work', search: rest };
}
