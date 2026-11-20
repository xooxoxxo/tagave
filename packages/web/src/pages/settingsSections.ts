/**
 * Settings is the server's (spec §3): each section names the permission it
 * needs (@tagave/shared › permissions). A listener has none, an editor the
 * library's tag writing and follow rules, the owner everything. The
 * person's own settings live in Your settings (youSections.ts); Genre
 * mapping and Background activity are Library care's tabs (workTabs.ts). A
 * plain module, not the lazy SettingsPage chunk, so Layout and the router
 * can read it.
 */
import { can, type Permission, type Role } from '@tagave/shared';

export type ServerSection = {
  value: string;
  label: string;
  permission: Permission;
  /** reachable by link, not in the nav */
  unlisted?: boolean;
};

export const SERVER_SECTIONS: readonly ServerSection[] = [
  { value: 'library', label: 'Library', permission: 'system.manage' },
  { value: 'tag-writing', label: 'Tag writing', permission: 'library.edit' },
  { value: 'following', label: 'Follow rules', permission: 'library.edit' },
  { value: 'people', label: 'People', permission: 'users.manage' },
  { value: 'modules', label: 'Modules', permission: 'system.manage' },
  { value: 'backups', label: 'Backups', permission: 'system.manage' },
  { value: 'updates', label: 'Updates', permission: 'system.manage' },
  { value: 'status', label: 'Status', permission: 'system.manage' },
  // First run shows it on Home; the route stays for direct links.
  { value: 'setup-checklist', label: 'Setup checklist', permission: 'system.manage', unlisted: true },
];

/** The listed sections the role may open, in nav order. */
export function settingsNav(role: Role | null): ServerSection[] {
  return SERVER_SECTIONS.filter((s) => !s.unlisted && can(role, s.permission));
}

export function serverSection(value: string): ServerSection | undefined {
  return SERVER_SECTIONS.find((s) => s.value === value);
}
