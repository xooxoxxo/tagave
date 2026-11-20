/**
 * Settings search (spec §3): a static index of the headings and row labels
 * each server section shows, copied from the pages (no server call). Search
 * looks only at the sections the role can see.
 */
import { MODULE_PAGES } from './moduleSettings';

export type IndexEntry = { section: string; label: string };

export const SETTINGS_INDEX: readonly IndexEntry[] = [
  // SettingsScanRootsPage, NamingSettings, DropPoolSettings, SettingsDeletingPage
  ...['Music folders', 'Naming', 'Drop pool', 'Deleting'].map((label) => ({ section: 'library', label })),
  // SettingsTagWritesPage
  ...['Tag preferences', 'Tag writes', 'Default write policy'].map((label) => ({ section: 'tag-writing', label })),
  // SettingsGenresPage
  ...['Genre mapping', 'Effective genres', 'Raw tags'].map((label) => ({ section: 'genre-mapping', label })),
  // SettingsFollowRulesPage
  { section: 'following', label: 'Follow rules' },
  // SettingsUsersPage, SignInService
  ...['Users', 'Invite', 'Open links', 'Sign-in service'].map((label) => ({ section: 'people', label })),
  // one row per module, then SettingsProvidersPage
  ...MODULE_PAGES.map((m) => ({ section: 'modules', label: m.name })),
  ...['Integrations', 'Contact', 'Discogs token', 'AcoustID key'].map((label) => ({ section: 'modules', label })),
  // SettingsBackupsPage group titles
  ...['Scheduled backups', 'Before update', 'Manual', 'Before restore'].map((label) => ({ section: 'backups', label })),
  // SettingsUpdatesPage
  ...['What’s new', 'Running now', 'Update checks'].map((label) => ({ section: 'updates', label })),
  // SystemStatus, SettingsStoragePage
  ...['System status', 'Storage', 'Database', 'Folders', 'Free space', 'Tag change cleanup'].map((label) => ({ section: 'status', label })),
  // JobsPage
  ...['Maintenance tasks', 'Needs attention', 'Recent activity', 'Album identification'].map((label) => ({ section: 'activity', label })),
];

export type SearchHit = { section: string; label: string; matches: string[] };

/**
 * The visible sections whose label, or one of whose indexed labels, holds
 * every word of the query (case-insensitive), in nav order; `matches` are
 * the indexed labels that hit. A blank query lists every visible section.
 */
export function searchSettings(query: string, visible: readonly { value: string; label: string }[]): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return visible.map((s) => ({ section: s.value, label: s.label, matches: [] }));
  const hits = (text: string) => {
    const lower = text.toLowerCase();
    return words.every((w) => lower.includes(w));
  };
  const found: SearchHit[] = [];
  for (const s of visible) {
    const matches = SETTINGS_INDEX.filter((e) => e.section === s.value && hits(e.label)).map((e) => e.label);
    if (matches.length > 0 || hits(s.label)) found.push({ section: s.value, label: s.label, matches });
  }
  return found;
}
