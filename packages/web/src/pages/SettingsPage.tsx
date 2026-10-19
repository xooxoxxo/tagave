import { Link, useLocation } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks';
import { useUpdateAvailable } from '../hooks/useUpdates';
import { UpdateDot } from '../components/UpdateDot';
import { PageShell, SegmentedControl, ThemeSwitch } from '../components/ui';
import { useMaintenance } from '../maintenance';
import { useDisplayPrefs } from '../displayPrefs';
import { useScrollFade } from '../components/ui/useScrollFade';
import { SettingsScanRootsContent } from './SettingsScanRootsPage';
import { SettingsTagWritesContent } from './SettingsTagWritesPage';
import { SettingsGenresContent } from './SettingsGenresPage';
import { SettingsFollowRulesContent } from './SettingsFollowRulesPage';
import { SettingsProvidersPage } from './SettingsProvidersPage';
import { SettingsUpdatesPage } from './SettingsUpdatesPage';
import { SettingsModulesContent } from './SettingsModulesPage';
import { SettingsPlaybackContent } from './SettingsPlaybackPage';
import { SettingsBackupsPage } from './SettingsBackupsPage';
import { SettingsStorageContent } from './SettingsStoragePage';
import { SettingsSecurityPage } from './SettingsSecurityPage';
import { SettingsListeningContent } from './SettingsListeningPage';
import { ConnectionsOff, SettingsConnectionsContent } from './SettingsConnectionsPage';
import { JobsPage } from './JobsPage';
import { SetupChecklistContent } from './SetupChecklistContent';
import { SystemStatus } from './Settings/SystemStatus';
import { SettingsUsersPage } from './SettingsUsersPage';
import { SettingsAccountPage } from './SettingsAccountPage';
import { NotAvailable } from '../components/access/NotAvailable';
import { useRole } from '../hooks/usePermissions';
import { useModuleOn } from '../hooks/useFacets';
import { can, type Permission } from '@tagave/shared';
import styles from './SettingsPage.module.css';

/**
 * Each section names the permission it needs (@tagave/shared › permissions):
 * a listener sees Account, Appearance, Security, Listening and Connections; an editor also the
 * library's tag, genre and follow settings and Background activity; the
 * owner everything. A direct link to a section the role lacks shows "Not
 * available for your account" in place of the section.
 */
type Section = { value: string; label: string; group: string; permission?: Permission };

const sections: Section[] = [
  { value: 'library', label: 'Music folders', group: 'Your library', permission: 'system.manage' },
  { value: 'metadata', label: 'Tag preferences', group: 'Your library', permission: 'library.edit' },
  { value: 'genre-mapping', label: 'Genre mapping', group: 'Your library', permission: 'library.edit' },
  { value: 'following', label: 'Follow rules', group: 'Your library', permission: 'library.edit' },
  { value: 'users', label: 'Users', group: 'Connections & system', permission: 'users.manage' },
  { value: 'providers', label: 'Integrations', group: 'Connections & system', permission: 'system.manage' },
  { value: 'playback', label: 'Playback', group: 'Connections & system', permission: 'system.manage' },
  { value: 'system', label: 'System status', group: 'Connections & system', permission: 'system.manage' },
  { value: 'storage', label: 'Storage', group: 'Connections & system', permission: 'system.manage' },
  { value: 'backups', label: 'Backups', group: 'Connections & system', permission: 'system.manage' },
  { value: 'updates', label: 'Updates', group: 'Connections & system', permission: 'system.manage' },
  // Modules change the install: system.manage is the owner's alone.
  { value: 'modules', label: 'Modules', group: 'Connections & system', permission: 'system.manage' },
  { value: 'activity', label: 'Background activity', group: 'Connections & system', permission: 'library.edit' },
  { value: 'setup-checklist', label: 'Setup checklist', group: 'Connections & system', permission: 'system.manage' },
  { value: 'account', label: 'Account', group: 'Your account' },
  { value: 'appearance', label: 'Appearance', group: 'Your account' },
  { value: 'security', label: 'Security', group: 'Your account' },
  { value: 'listening', label: 'Listening', group: 'Your account' },
  // Music Connections: each person links tagave to other music apps for themselves
  { value: 'connections', label: 'Connections', group: 'Your account' },
];

export function SettingsPage() {
  const role = useRole();
  // Music Connections off (Settings › Modules, off by default): Connections says so
  const mcOn = useModuleOn('mc');
  const visible = sections.filter((item) => !item.permission || can(role, item.permission));
  const raw = useLocation().pathname.split('/')[2] || visible[0]?.value || 'appearance';
  const known = sections.find((item) => item.value === raw);
  const section = known ? raw : visible[0]?.value ?? 'appearance';
  const allowed = !known?.permission || can(role, known.permission);
  // On a phone the section list is one scrolling row: the hook brings the
  // current section into it and fades the edge that hides more sections.
  const navRef = useScrollFade<HTMLElement>(section);
  const { libraryId } = useCurrentLibrary();
  // the release feed is the owner's: nobody else is asked about it
  const updateAvailable = useUpdateAvailable(can(role, 'system.manage') ? libraryId : undefined);
  const canMaintain = can(role, 'library.edit');
  return <PageShell title="Settings">
    <div className={styles.layout}>
      <nav ref={navRef} className={styles.sectionNav} aria-label="Settings sections">{visible.map((item, i) => <div key={item.value}>{item.group !== visible[i - 1]?.group && <p className={styles.groupLabel}>{item.group}</p>}<Link to="/settings/$section" params={{ section: item.value }} className={item.value === section ? styles.activeSection : styles.sectionLink} aria-current={item.value === section ? 'page' : undefined}>{item.label}{item.value === 'updates' && updateAvailable && <UpdateDot />}</Link></div>)}</nav>
      <div className={styles.content}>
        {!allowed ? <NotAvailable inline /> : <>
        {section === 'library' && <SettingsScanRootsContent />}
        {section === 'metadata' && <SettingsTagWritesContent />}
        {section === 'genre-mapping' && <SettingsGenresContent />}
        {section === 'following' && <SettingsFollowRulesContent />}
        {section === 'appearance' && <><h2>Appearance</h2><ThemeSwitch />{canMaintain && <MaintenanceSetting />}<DisplaySettings /></>}
        {section === 'users' && <><h2>Users</h2><SettingsUsersPage /></>}
        {section === 'account' && <><h2>Account</h2><SettingsAccountPage /></>}
        {section === 'providers' && <><h2>Integrations</h2><SettingsProvidersPage /></>}
        {section === 'playback' && <SettingsPlaybackContent />}
        {section === 'system' && <><h2>System status</h2><SystemStatus /></>}
        {section === 'storage' && <><h2>Storage</h2><SettingsStorageContent /></>}
        {section === 'backups' && <><h2>Backups</h2><SettingsBackupsPage /></>}
        {section === 'updates' && <><h2>Updates</h2><SettingsUpdatesPage /></>}
        {section === 'modules' && <><h2>Modules</h2><SettingsModulesContent /></>}
        {section === 'activity' && <><h2>Background activity</h2><JobsPage /></>}
        {section === 'setup-checklist' && <><h2>Setup checklist</h2><SetupChecklistContent /></>}
        {section === 'listening' && <SettingsListeningContent />}
        {section === 'connections' && (mcOn === false ? <ConnectionsOff modules={can(role, 'system.manage') ? <Link to="/settings/$section" params={{ section: 'modules' }}>Settings › Modules</Link> : null} /> : <SettingsConnectionsContent />)}
        {section === 'security' && <><h2>Security</h2><SettingsSecurityPage /></>}
        </>}
      </div>
    </div>
  </PageShell>;
}

/**
 * Maintenance: curation tools (match state, provider links, library issues,
 * the Manage menu) show only while it is on. The same switch sits in the
 * app bar (Shift+M).
 */
function MaintenanceSetting() {
  const [on, setOn] = useMaintenance();
  // Same heading level and rhythm as Appearance above: siblings in the
  // section's column, so the gap above the control matches too.
  return <>
    <h2 className={styles.modeSetting}>Maintenance</h2>
    
    <SegmentedControl label="Maintenance" value={on ? 'on' : 'off'} onChange={(v) => setOn(v === 'on')} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} />
  </>;
}


/**
 * Sidebar, album and artist display: where the search sits, the wordmark,
 * the artwork under short albums, and the artist page's layout. Each is its own setting with the same rhythm
 * as Maintenance above.
 */
function DisplaySettings() {
  const [prefs, setPrefs] = useDisplayPrefs();
  return <>
    <h2 className={styles.modeSetting}>Search box</h2>
    
    <SegmentedControl label="Search box" value={prefs.searchPlacement} onChange={(v) => setPrefs({ searchPlacement: v })} options={[{ value: 'below', label: 'Below the logo' }, { value: 'beside', label: 'Next to the logo' }]} />
    <h2 className={styles.modeSetting}>Wordmark</h2>
    
    <SegmentedControl label="Wordmark" value={prefs.showWordmark ? 'shown' : 'hidden'} onChange={(v) => setPrefs({ showWordmark: v === 'shown' })} options={[{ value: 'shown', label: 'Shown' }, { value: 'hidden', label: 'Hidden' }]} />
    <h2 className={styles.modeSetting}>Short albums</h2>
    
    <SegmentedControl label="Short album artwork" value={prefs.shortAlbumArt ? 'on' : 'off'} onChange={(v) => setPrefs({ shortAlbumArt: v === 'on' })} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
    <h2 className={styles.modeSetting}>Artist page</h2>
    
    <SegmentedControl label="Artist page" value={prefs.artistLayout} onChange={(v) => setPrefs({ artistLayout: v })} options={[{ value: 'name', label: 'Name first' }, { value: 'albums', label: 'Like albums' }]} />
  </>;
}
