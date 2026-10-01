import { Link, useLocation } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks';
import { useUpdateAvailable } from '../hooks/useUpdates';
import { UpdateDot } from '../components/UpdateDot';
import { PageShell, SegmentedControl, ThemeSwitch } from '../components/ui';
import { useMaintenance } from '../maintenance';
import { useScrollFade } from '../components/ui/useScrollFade';
import { SettingsScanRootsContent } from './SettingsScanRootsPage';
import { SettingsTagWritesContent } from './SettingsTagWritesPage';
import { SettingsGenresContent } from './SettingsGenresPage';
import { SettingsFollowRulesContent } from './SettingsFollowRulesPage';
import { SettingsProvidersPage } from './SettingsProvidersPage';
import { SettingsUpdatesPage } from './SettingsUpdatesPage';
import { SettingsBackupsPage } from './SettingsBackupsPage';
import { JobsPage } from './JobsPage';
import { SetupChecklistContent } from './SetupChecklistContent';
import { SystemStatus } from './Settings/SystemStatus';
import styles from './SettingsPage.module.css';

const sections = [
  { value: 'library', label: 'Music folders', group: 'Your library' },
  { value: 'metadata', label: 'Tag preferences' },
  { value: 'genre-mapping', label: 'Genre mapping' },
  { value: 'following', label: 'Follow rules' },
  { value: 'appearance', label: 'Appearance' },
  { value: 'providers', label: 'Integrations', group: 'Connections & system' },
  { value: 'system', label: 'System status' },
  { value: 'backups', label: 'Backups' },
  { value: 'updates', label: 'Updates' },
  { value: 'activity', label: 'Background activity' },
  { value: 'setup-checklist', label: 'Setup checklist' },
];
export function SettingsPage() {
  const raw = useLocation().pathname.split('/')[2] || 'library';
  const section = sections.some(item => item.value === raw) ? raw : 'library';
  // On a phone the section list is one scrolling row: the hook brings the
  // current section into it and fades the edge that hides more sections.
  const navRef = useScrollFade<HTMLElement>(section);
  const updateAvailable = useUpdateAvailable(useCurrentLibrary().libraryId);
  return <PageShell title="Settings" subtitle="Make tagave at home in your library.">
    <div className={styles.layout}>
      <nav ref={navRef} className={styles.sectionNav} aria-label="Settings sections">{sections.map(item => <div key={item.value}>{item.group && <p className={styles.groupLabel}>{item.group}</p>}<Link to="/settings/$section" params={{ section: item.value }} className={item.value === section ? styles.activeSection : styles.sectionLink} aria-current={item.value === section ? 'page' : undefined}>{item.label}{item.value === 'updates' && updateAvailable && <UpdateDot />}</Link></div>)}</nav>
      <div className={styles.content}>
        {section === 'library' && <SettingsScanRootsContent />}
        {section === 'metadata' && <SettingsTagWritesContent />}
        {section === 'genre-mapping' && <SettingsGenresContent />}
        {section === 'following' && <SettingsFollowRulesContent />}
        {section === 'appearance' && <><h2>Appearance</h2><p className={styles.sectionDescription}>Choose light or dark, or follow your device. This is remembered in this browser only.</p><ThemeSwitch /><MaintenanceSetting /></>}
        {section === 'providers' && <><h2>Integrations</h2><p className={styles.sectionDescription}>Connect metadata and artwork providers to enrich your music.</p><SettingsProvidersPage /></>}
        {section === 'system' && <><h2>System status</h2><p className={styles.sectionDescription}>Health checks with a fix for anything that fails. Versions and connected workers are under <Link to="/settings/$section" params={{ section: 'updates' }}>Updates</Link>.</p><SystemStatus /></>}
        {section === 'backups' && <><h2>Backups</h2><p className={styles.sectionDescription}>Copies of the database: your catalog, matches, reviews and settings. Your music files are not in them.</p><SettingsBackupsPage /></>}
        {section === 'updates' && <><h2>Updates</h2><p className={styles.sectionDescription}>New versions, what they change, and how to update this server.</p><SettingsUpdatesPage /></>}
        {section === 'activity' && <><h2>Background activity</h2><p className={styles.sectionDescription}>Follow scans and processing jobs, and investigate failures.</p><JobsPage /></>}
        {section === 'setup-checklist' && <><h2>Setup checklist</h2><SetupChecklistContent /></>}
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
    <p className={styles.sectionDescription}>Off, albums show only the music and speak up only when something needs your decision. On, every album shows its match state, provider links, all library issues and the Manage menu. Also in the top bar, or press Shift+M. Remembered in this browser only.</p>
    <SegmentedControl label="Maintenance" value={on ? 'on' : 'off'} onChange={(v) => setOn(v === 'on')} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} />
  </>;
}

