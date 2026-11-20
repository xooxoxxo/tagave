import { useLocation } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks';
import { useUpdateAvailable } from '../hooks/useUpdates';
import { PageShell } from '../components/ui';
import { SectionNav } from '../components/settings/SectionNav';
import { YouAppearance } from './YouAppearance';
import { usePhoneSubpage } from '../components/appBarTitle';
import { SettingsScanRootsContent } from './SettingsScanRootsPage';
import { NamingSettings } from '../components/naming/NamingSettings';
import { DropPoolSettings } from '../components/naming/DropPoolSettings';
import { SettingsDeletingContent } from './SettingsDeletingPage';
import { SettingsTagWritesContent } from './SettingsTagWritesPage';
import { SettingsGenresContent } from './SettingsGenresPage';
import { SettingsFollowRulesContent } from './SettingsFollowRulesPage';
import { SettingsProvidersPage } from './SettingsProvidersPage';
import { SettingsUpdatesPage } from './SettingsUpdatesPage';
import { SettingsModuleContent, SettingsModulesContent, useModuleRows } from './SettingsModulesPage';
import { MODULE_PAGES } from './moduleSettings';
import { SettingsBackupsPage } from './SettingsBackupsPage';
import { SettingsStorageContent } from './SettingsStoragePage';
import { SettingsSecurityPage } from './SettingsSecurityPage';
import { JobsPage } from './JobsPage';
import { SetupChecklistContent } from './SetupChecklistContent';
import { SystemStatus } from './Settings/SystemStatus';
import { SettingsUsersPage } from './SettingsUsersPage';
import { SignInService } from '../components/users/SignInService';
import { SettingsAccountPage } from './SettingsAccountPage';
import { CUSTOM_THEME_SECTION, CustomThemeScreen } from '../themes/ThemeSetting';
import { NotAvailable } from '../components/access/NotAvailable';
import { useRole } from '../hooks/usePermissions';
import { can, type Permission } from '@tagave/shared';
import styles from './SettingsPage.module.css';

/**
 * Each section names the permission it needs (@tagave/shared › permissions):
 * a listener sees Account, Appearance, Security and the modules that have
 * something of theirs (Modules); an editor also the library's tag, genre
 * and follow settings and Background activity; the owner everything. Each
 * module's settings live in Settings › Modules › <module>. A direct link to a section the role lacks shows "Not
 * available for your account" in place of the section.
 */
type Section = { value: string; label: string; group: string; permission?: Permission; /** reachable by link, not in the nav */ unlisted?: boolean };

const sections: Section[] = [
  { value: 'library', label: 'Music folders', group: 'Library', permission: 'system.manage' },
  // Mark or Trash: a deletion reaches the music folder, so the owner's alone
  { value: 'deleting', label: 'Deleting', group: 'Library', permission: 'system.manage' },
  { value: 'metadata', label: 'Tag preferences', group: 'Library', permission: 'library.edit' },
  { value: 'genre-mapping', label: 'Genre mapping', group: 'Library', permission: 'library.edit' },
  { value: 'following', label: 'Follow rules', group: 'Library', permission: 'library.edit' },
  { value: 'users', label: 'Users', group: 'System', permission: 'users.manage' },
  { value: 'providers', label: 'Integrations', group: 'System', permission: 'system.manage' },
  { value: 'system', label: 'System status', group: 'System', permission: 'system.manage' },
  { value: 'storage', label: 'Storage', group: 'System', permission: 'system.manage' },
  { value: 'backups', label: 'Backups', group: 'System', permission: 'system.manage' },
  { value: 'updates', label: 'Updates', group: 'System', permission: 'system.manage' },
  // Every module's settings (owner: all of them and their Off | On; anyone
  // else: the ones with something of theirs, e.g. Listen elsewhere)
  { value: 'modules', label: 'Modules', group: 'System' },
  { value: 'activity', label: 'Background activity', group: 'System', permission: 'library.edit' },
  // First run shows it on Home; the route stays for direct links.
  { value: 'setup-checklist', label: 'Setup checklist', group: 'System', permission: 'system.manage', unlisted: true },
  { value: 'account', label: 'Account', group: 'Account' },
  { value: 'appearance', label: 'Appearance', group: 'Account' },
  // Appearance › Theme › Custom, a screen of its own on a phone
  { value: CUSTOM_THEME_SECTION, label: 'Custom theme', group: 'Account', unlisted: true },
  { value: 'security', label: 'Security', group: 'Account' },
];

/**
 * The sections the nav lists for a role. Modules is listed for the owner,
 * and for anyone else while a module has something of theirs (`modules`:
 * how many rows Settings › Modules shows them; null or undefined while
 * they load).
 */
export function settingsNav(role: Parameters<typeof can>[0], modules: { rows?: number | null | undefined } = {}): Section[] {
  const owner = can(role, 'system.manage');
  const listed = sections.filter((item) => !item.unlisted && (!item.permission || can(role, item.permission))
    && (item.value !== 'modules' || owner || (modules.rows ?? 0) > 0));
  if (owner) return listed;
  // anyone else reaches only their own part of a module: it sits with their account
  const mod = listed.find((item) => item.value === 'modules');
  return mod ? [...listed.filter((item) => item !== mod), { ...mod, group: 'Account' }] : listed;
}

export function SettingsPage() {
  const role = useRole();
  const moduleRows = useModuleRows();
  const visible = settingsNav(role, { rows: moduleRows?.length ?? null });
  const parts = useLocation().pathname.split('/');
  const raw = parts[2] || visible[0]?.value || 'appearance';
  const known = sections.find((item) => item.value === raw);
  const section = known ? raw : visible[0]?.value ?? 'appearance';
  const allowed = !known?.permission || can(role, known.permission);
  // Settings › Modules › <module>: a page of its own under Modules
  const moduleSlug = section === 'modules' ? parts[3] || null : null;
  const moduleName = moduleSlug ? MODULE_PAGES.find((m) => m.slug === moduleSlug)?.name ?? moduleRows?.find((r) => r.slug === moduleSlug)?.name ?? moduleSlug : null;
  // On a phone /settings is the list of sections and each section its own
  // page: the top bar shows a back key to the list and the section's name.
  const view = parts[2] ? 'section' : 'list';
  // Custom theme is a part of Appearance, a module page of Modules: the way back, and the section the nav marks
  const parent = section === CUSTOM_THEME_SECTION ? 'appearance' : section;
  const nested = parent !== section || moduleSlug !== null;
  usePhoneSubpage(view === 'section' ? moduleName ?? known?.label ?? null : null, nested ? `/settings/${parent}` : '/settings');
  const { libraryId } = useCurrentLibrary();
  // the release feed is the owner's: nobody else is asked about it
  const updateAvailable = useUpdateAvailable(can(role, 'system.manage') ? libraryId : undefined);
  return <PageShell title="Settings" sticky>
    <div className={styles.layout} data-view={view}>
      <SectionNav
        className={styles.sectionNav}
        label="Settings sections"
        items={visible.map((item) => ({ value: item.value, label: item.label, group: item.group, to: `/settings/${item.value}`, dot: item.value === 'updates' && !!updateAvailable }))}
        current={parent}
      />
      <div className={styles.content}>
        {!allowed ? <NotAvailable inline /> : <>
        {section === 'library' && <><SettingsScanRootsContent /><NamingSettings /><DropPoolSettings /></>}
        {section === 'deleting' && <SettingsDeletingContent />}
        {section === 'metadata' && <SettingsTagWritesContent />}
        {section === 'genre-mapping' && <SettingsGenresContent />}
        {section === 'following' && <SettingsFollowRulesContent />}
        {section === 'appearance' && <><h2>Appearance</h2><YouAppearance /></>}
        {section === CUSTOM_THEME_SECTION && <><h2>Custom theme</h2><CustomThemeScreen /></>}
        {section === 'users' && <><h2>Users</h2><SettingsUsersPage /><SignInService headingClassName={styles.modeSetting} /></>}
        {section === 'account' && <><h2>Account</h2><SettingsAccountPage /></>}
        {section === 'providers' && <><h2>Integrations</h2><SettingsProvidersPage /></>}
        {section === 'system' && <><h2>System status</h2><SystemStatus /></>}
        {section === 'storage' && <><h2>Storage</h2><SettingsStorageContent /></>}
        {section === 'backups' && <><h2>Backups</h2><SettingsBackupsPage /></>}
        {section === 'updates' && <SettingsUpdatesPage />}
        {section === 'modules' && (moduleSlug ? <SettingsModuleContent slug={moduleSlug} /> : <><h2>Modules</h2><SettingsModulesContent /></>)}
        {section === 'activity' && <><h2>Background activity</h2><JobsPage /></>}
        {section === 'setup-checklist' && <><h2>Setup checklist</h2><SetupChecklistContent /></>}
        {section === 'security' && <><h2>Security</h2><SettingsSecurityPage /></>}
        </>}
      </div>
    </div>
  </PageShell>;
}
