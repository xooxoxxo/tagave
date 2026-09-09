import { Link, useLocation } from '@tanstack/react-router';
import { PageShell } from '../components/ui';
import { SettingsScanRootsContent } from './SettingsScanRootsPage';
import { SettingsTagWritesContent } from './SettingsTagWritesPage';
import { SettingsGenresContent } from './SettingsGenresPage';
import { SettingsFollowRulesContent } from './SettingsFollowRulesPage';
import { SettingsProvidersPage } from './SettingsProvidersPage';
import { SettingsUpdatesPage } from './SettingsUpdatesPage';
import { JobsPage } from './JobsPage';
import { SetupChecklistContent } from './SetupChecklistContent';
import styles from './SettingsPage.module.css';

const sections = [
  { value: 'library', label: 'Music folders', group: 'Your library' },
  { value: 'metadata', label: 'Tag preferences' },
  { value: 'genre-mapping', label: 'Genre mapping' },
  { value: 'following', label: 'Follow rules' },
  { value: 'providers', label: 'Integrations', group: 'Connections & system' },
  { value: 'system', label: 'System status' },
  { value: 'activity', label: 'Background activity' },
  { value: 'setup-checklist', label: 'Setup checklist' },
];
export function SettingsPage() {
  const raw = useLocation().pathname.split('/')[2] || 'library';
  const section = sections.some(item => item.value === raw) ? raw : 'library';
  return <PageShell title="Settings" subtitle="Make tagave at home in your library.">
    <div className={styles.layout}>
      <nav className={styles.sectionNav} aria-label="Settings sections">{sections.map(item => <div key={item.value}>{item.group && <p className={styles.groupLabel}>{item.group}</p>}<Link to="/settings/$section" params={{ section: item.value }} className={item.value === section ? styles.activeSection : styles.sectionLink} aria-current={item.value === section ? 'page' : undefined}>{item.label}</Link></div>)}</nav>
      <div className={styles.content}>
        {section === 'library' && <SettingsScanRootsContent />}
        {section === 'metadata' && <SettingsTagWritesContent />}
        {section === 'genre-mapping' && <SettingsGenresContent />}
        {section === 'following' && <SettingsFollowRulesContent />}
        {section === 'providers' && <><h2>Integrations</h2><p className={styles.sectionDescription}>Connect metadata and artwork providers to enrich your music.</p><SettingsProvidersPage /></>}
        {section === 'system' && <><h2>System status</h2><p className={styles.sectionDescription}>Application versions and connected workers.</p><SettingsUpdatesPage /></>}
        {section === 'activity' && <><h2>Background activity</h2><p className={styles.sectionDescription}>Follow scans and processing jobs, and investigate failures.</p><JobsPage /></>}
        {section === 'setup-checklist' && <><h2>Setup checklist</h2><SetupChecklistContent /></>}
      </div>
    </div>
  </PageShell>;
}
