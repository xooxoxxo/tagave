import { useState } from 'react';
import { useLocation } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks';
import { useUpdateAvailable } from '../hooks/useUpdates';
import { PageShell } from '../components/ui';
import { SectionNav } from '../components/settings/SectionNav';
import { SettingsSearch } from '../components/settings/SettingsSearch';
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
import { JobsPage } from './JobsPage';
import { SetupChecklistContent } from './SetupChecklistContent';
import { SystemStatus } from './Settings/SystemStatus';
import { SettingsUsersPage } from './SettingsUsersPage';
import { SignInService } from '../components/users/SignInService';
import { NotAvailable } from '../components/access/NotAvailable';
import { useRole } from '../hooks/usePermissions';
import { can } from '@tagave/shared';
import { serverSection, settingsNav } from './settingsSections';
import { searchSettings } from './settingsIndex';
import { settingsNavItems } from './settingsNavItems';
import styles from './SettingsPage.module.css';

/**
 * Settings is the server's (spec §3): the sections and the permission each
 * needs come from settingsSections.ts. A listener has none (their own
 * settings are Your settings, /you); an editor has Tag writing, Genre
 * mapping, Follow rules and Background activity; the owner everything. A
 * search above the list filters it over a static index of labels. A direct
 * link to a section the role lacks shows "Not available for your account"
 * in place of the section.
 */
export function SettingsPage() {
  const role = useRole();
  const moduleRows = useModuleRows();
  const visible = settingsNav(role);
  const parts = useLocation().pathname.split('/');
  const known = parts[2] ? serverSection(parts[2]) : undefined;
  // an unknown section opens the first listed one
  const current = known ?? visible[0];
  const section = current?.value ?? null;
  const allowed = !!current && can(role, current.permission);
  // Settings › Modules › <module>: a page of its own under Modules
  const moduleSlug = section === 'modules' ? parts[3] || null : null;
  const moduleName = moduleSlug ? MODULE_PAGES.find((m) => m.slug === moduleSlug)?.name ?? moduleRows?.find((r) => r.slug === moduleSlug)?.name ?? moduleSlug : null;
  // On a phone /settings is the list of sections and each section its own
  // page: the top bar shows a back key to the list and the section's name.
  const view = parts[2] ? 'section' : 'list';
  usePhoneSubpage(view === 'section' ? moduleName ?? current?.label ?? null : null, moduleSlug ? '/settings/modules' : '/settings');
  const { libraryId } = useCurrentLibrary();
  // the release feed is the owner's: nobody else is asked about it
  const updateAvailable = useUpdateAvailable(can(role, 'system.manage') ? libraryId : undefined);
  const [query, setQuery] = useState('');
  // one section needs no search
  const searchable = visible.length > 1;
  const hits = searchSettings(searchable ? query : '', visible);
  return <PageShell title="Settings" sticky>
    <div className={styles.layout} data-view={view}>
      <SectionNav
        className={styles.sectionNav}
        label="Settings sections"
        items={settingsNavItems(hits, !!updateAvailable)}
        current={section}
        search={searchable ? <SettingsSearch value={query} onChange={setQuery} /> : undefined}
        empty="No match"
      />
      <div className={styles.content}>
        {!allowed ? <NotAvailable inline /> : <>
        {section === 'library' && <><SettingsScanRootsContent /><NamingSettings /><DropPoolSettings /><SettingsDeletingContent /></>}
        {section === 'tag-writing' && <SettingsTagWritesContent />}
        {section === 'genre-mapping' && <SettingsGenresContent />}
        {section === 'following' && <SettingsFollowRulesContent />}
        {section === 'people' && <><h2>People</h2><SettingsUsersPage /><SignInService headingClassName={styles.modeSetting} /></>}
        {section === 'modules' && (moduleSlug ? <SettingsModuleContent slug={moduleSlug} /> : <><h2>Modules</h2><SettingsModulesContent /><h2 id="integrations" className={styles.modeSetting}>Integrations</h2><SettingsProvidersPage /></>)}
        {section === 'backups' && <><h2>Backups</h2><SettingsBackupsPage /></>}
        {section === 'updates' && <SettingsUpdatesPage />}
        {section === 'status' && <><h2>Status</h2><SystemStatus /><h2 className={styles.modeSetting}>Storage</h2><SettingsStorageContent /></>}
        {section === 'activity' && <><h2>Background activity</h2><JobsPage /></>}
        {section === 'setup-checklist' && <><h2>Setup checklist</h2><SetupChecklistContent /></>}
        </>}
      </div>
    </div>
  </PageShell>;
}
