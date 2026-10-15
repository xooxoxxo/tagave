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
import { SettingsPlaybackContent } from './SettingsPlaybackPage';
import { SettingsBackupsPage } from './SettingsBackupsPage';
import { SettingsStorageContent } from './SettingsStoragePage';
import { SettingsSecurityPage } from './SettingsSecurityPage';
import { SettingsListeningContent } from './SettingsListeningPage';
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
  { value: 'playback', label: 'Playback' },
  { value: 'system', label: 'System status' },
  { value: 'storage', label: 'Storage' },
  { value: 'backups', label: 'Backups' },
  { value: 'updates', label: 'Updates' },
  { value: 'activity', label: 'Background activity' },
  { value: 'setup-checklist', label: 'Setup checklist' },
  { value: 'security', label: 'Security', group: 'Your account' },
  { value: 'listening', label: 'Listening' },
];
export function SettingsPage() {
  const raw = useLocation().pathname.split('/')[2] || 'library';
  const section = sections.some(item => item.value === raw) ? raw : 'library';
  // On a phone the section list is one scrolling row: the hook brings the
  // current section into it and fades the edge that hides more sections.
  const navRef = useScrollFade<HTMLElement>(section);
  const updateAvailable = useUpdateAvailable(useCurrentLibrary().libraryId);
  return <PageShell title="Settings">
    <div className={styles.layout}>
      <nav ref={navRef} className={styles.sectionNav} aria-label="Settings sections">{sections.map(item => <div key={item.value}>{item.group && <p className={styles.groupLabel}>{item.group}</p>}<Link to="/settings/$section" params={{ section: item.value }} className={item.value === section ? styles.activeSection : styles.sectionLink} aria-current={item.value === section ? 'page' : undefined}>{item.label}{item.value === 'updates' && updateAvailable && <UpdateDot />}</Link></div>)}</nav>
      <div className={styles.content}>
        {section === 'library' && <SettingsScanRootsContent />}
        {section === 'metadata' && <SettingsTagWritesContent />}
        {section === 'genre-mapping' && <SettingsGenresContent />}
        {section === 'following' && <SettingsFollowRulesContent />}
        {section === 'appearance' && <><h2>Appearance</h2><p className={styles.sectionDescription}>Choose light or dark, or follow your device. This is remembered in this browser only.</p><ThemeSwitch /><MaintenanceSetting /><DisplaySettings /></>}
        {section === 'providers' && <><h2>Integrations</h2><p className={styles.sectionDescription}>Connect metadata and artwork providers to enrich your music.</p><SettingsProvidersPage /></>}
        {section === 'playback' && <SettingsPlaybackContent />}
        {section === 'system' && <><h2>System status</h2><p className={styles.sectionDescription}>Health checks with a fix for anything that fails. Versions and connected workers are under <Link to="/settings/$section" params={{ section: 'updates' }}>Updates</Link>.</p><SystemStatus /></>}
        {section === 'storage' && <><h2>Storage</h2><p className={styles.sectionDescription}>How much room tagave takes: the database by kind of data, and the folders it keeps on this server. Your music files are not counted.</p><SettingsStorageContent /></>}
        {section === 'backups' && <><h2>Backups</h2><p className={styles.sectionDescription}>Copies of the database: your catalog, matches, reviews and settings. Your music files are not in them.</p><SettingsBackupsPage /></>}
        {section === 'updates' && <><h2>Updates</h2><p className={styles.sectionDescription}>New releases and the versions this server runs.</p><SettingsUpdatesPage /></>}
        {section === 'activity' && <><h2>Background activity</h2><p className={styles.sectionDescription}>Follow scans and processing jobs, and investigate failures.</p><JobsPage /></>}
        {section === 'setup-checklist' && <><h2>Setup checklist</h2><SetupChecklistContent /></>}
        {section === 'listening' && <SettingsListeningContent />}
        {section === 'security' && <><h2>Security</h2><p className={styles.sectionDescription}>How you sign in, and what keeps your account yours if a password leaks or a device is lost.</p><SettingsSecurityPage /></>}
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


/**
 * Sidebar, album and artist display: where the search sits, the wordmark,
 * the artwork under short albums, and the artist page's layout. Each is its own setting with the same rhythm
 * as Maintenance above.
 */
function DisplaySettings() {
  const [prefs, setPrefs] = useDisplayPrefs();
  return <>
    <h2 className={styles.modeSetting}>Search box</h2>
    <p className={styles.sectionDescription}>Where the search box sits in the sidebar: on its own line below the logo, or on the logo's row. On a phone or tablet the top bar keeps its own layout. Remembered in this browser only.</p>
    <SegmentedControl label="Search box" value={prefs.searchPlacement} onChange={(v) => setPrefs({ searchPlacement: v })} options={[{ value: 'below', label: 'Below the logo' }, { value: 'beside', label: 'Next to the logo' }]} />
    <h2 className={styles.modeSetting}>Wordmark</h2>
    <p className={styles.sectionDescription}>Show the name "tagave" next to the mark, or the mark alone. Remembered in this browser only.</p>
    <SegmentedControl label="Wordmark" value={prefs.showWordmark ? 'shown' : 'hidden'} onChange={(v) => setPrefs({ showWordmark: v === 'shown' })} options={[{ value: 'shown', label: 'Shown' }, { value: 'hidden', label: 'Hidden' }]} />
    <h2 className={styles.modeSetting}>Short albums</h2>
    <p className={styles.sectionDescription}>Albums of three tracks or fewer get a generated ripple artwork under the tracklist, drawn from the album's title. Remembered in this browser only.</p>
    <SegmentedControl label="Short album artwork" value={prefs.shortAlbumArt ? 'on' : 'off'} onChange={(v) => setPrefs({ shortAlbumArt: v === 'on' })} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
    <h2 className={styles.modeSetting}>Artist page</h2>
    <p className={styles.sectionDescription}>Name first: the artist's name across the top, their details in a column that also takes you to each section. Like albums: their covers beside the name, laid out like an album page. Remembered in this browser only.</p>
    <SegmentedControl label="Artist page" value={prefs.artistLayout} onChange={(v) => setPrefs({ artistLayout: v })} options={[{ value: 'name', label: 'Name first' }, { value: 'albums', label: 'Like albums' }]} />
  </>;
}
