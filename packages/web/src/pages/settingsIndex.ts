/**
 * Settings search (spec §3): a static index of the headings and row labels
 * each server section shows, copied from the pages (no server call). Search
 * looks only at the sections the role can see.
 */
import { MODULE_PAGES } from './moduleSettings';

export type IndexEntry = { section: string; label: string };

export const SETTINGS_INDEX: readonly IndexEntry[] = [
  // group titles and row labels (settingsIndex.test.ts checks each is on its page)
  // SettingsScanRootsPage
  ...['Music folders', 'Scanning', 'Tag writes', 'Rescan every', 'Folder link', 'Add music folder', 'Path'].map((label) => ({ section: 'library', label })),
  // NamingSettings, DropPoolSettings, SettingsDeletingPage
  ...['Naming', 'File', 'Soundtrack', 'Compilation', 'Leave alone', 'Examples', 'Drop pool', 'Music folder', 'Deleting'].map((label) => ({ section: 'library', label })),
  // SettingsTagWritesPage
  ...['Tag writes', 'Writable folders', 'Default write policy', 'Preset', 'MP3 tags', 'Separator'].map((label) => ({ section: 'tag-writing', label })),
  // SettingsFollowRulesPage
  ...['Include', 'Exclude', 'Auto-follow', 'Auto-follow at'].map((label) => ({ section: 'following', label })),
  // SettingsUsersPage (UsersList), SignInService
  ...['People', 'Invite', 'Email', 'Role', 'Open links'].map((label) => ({ section: 'people', label })),
  ...['Sign-in service', 'Name', 'Issuer', 'Client ID', 'Client secret', 'Redirect URI', 'Join', 'Sign-in button', 'Anyone can join', 'Group'].map((label) => ({ section: 'people', label })),
  // one row per module, then SettingsProvidersPage
  ...MODULE_PAGES.map((m) => ({ section: 'modules', label: m.name })),
  ...['Integrations', 'Contact', 'Discogs token', 'AcoustID key', 'Fingerprinting', 'Discogs IDs'].map((label) => ({ section: 'modules', label })),
  // SettingsBackupsPage group titles
  ...['Scheduled backups', 'Before update', 'Manual', 'Before restore'].map((label) => ({ section: 'backups', label })),
  // SettingsUpdatesPage
  ...['What’s new', 'Running now', 'Update checks', 'Last check', 'Feed'].map((label) => ({ section: 'updates', label })),
  // SystemStatus, SettingsStoragePage
  ...['System status', 'Checks', 'Storage', 'Total', 'Database', 'Folders', 'Free space', 'Tag change cleanup', 'Which plans'].map((label) => ({ section: 'status', label })),
];

export type SearchHit = { section: string; label: string; matches: string[] };

/** lower case, curly apostrophes as straight ones */
const fold = (text: string) => text.toLowerCase().replace(/[\u2018\u2019]/g, "'");

/**
 * The visible sections whose label, or one of whose indexed labels, holds
 * every word of the query (case-insensitive), in nav order; `matches` are
 * the indexed labels that hit. A blank query lists every visible section.
 */
export function searchSettings(query: string, visible: readonly { value: string; label: string }[]): SearchHit[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return visible.map((s) => ({ section: s.value, label: s.label, matches: [] }));
  const hits = (text: string) => {
    const lower = fold(text);
    return words.every((w) => lower.includes(w));
  };
  const found: SearchHit[] = [];
  for (const s of visible) {
    const matches = SETTINGS_INDEX.filter((e) => e.section === s.value && hits(e.label)).map((e) => e.label);
    if (matches.length > 0 || hits(s.label)) found.push({ section: s.value, label: s.label, matches });
  }
  return found;
}
