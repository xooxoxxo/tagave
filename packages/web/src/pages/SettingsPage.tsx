/**
 * Settings page: unified surface with sections for library, providers, collection, system
 * Renders sub-pages based on the section parameter (/settings/$section)
 */

import { useParams, useNavigate } from '@tanstack/react-router';
import { PageShell, TabItem } from '../components/ui';
import { SettingsScanRootsContent } from './SettingsScanRootsPage';
import { SettingsTagWritesContent } from './SettingsTagWritesPage';
import { SettingsGenresContent } from './SettingsGenresPage';
import { SettingsFollowRulesContent } from './SettingsFollowRulesPage';
import { SettingsProvidersPage } from './SettingsProvidersPage';
import { CollectionPage } from './CollectionPage';
import { SettingsUpdatesPage } from './SettingsUpdatesPage';
import { JobsPage } from './JobsPage';
import { SetupChecklistContent } from './SetupChecklistContent';
import styles from './SettingsPage.module.css';

type SettingsSection = 'library' | 'providers' | 'collection' | 'system';

export function SettingsPage() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { section?: string };
  const section = (params.section || 'library') as SettingsSection;

  const tabs: TabItem[] = [
    { label: 'Library', value: 'library' },
    { label: 'Providers', value: 'providers' },
    { label: 'Collection', value: 'collection' },
    { label: 'System', value: 'system' },
  ];

  const handleTabChange = (value: string) => {
    if (value === 'library') {
      navigate({ to: '/settings' });
    } else {
      navigate({ to: `/settings/${value}` });
    }
  };

  return (
    <PageShell
      title="Settings"
      subtitle="Configure your library and application"
      tabs={tabs}
      activeTab={section}
      onTabChange={handleTabChange}
    >
      <div className={styles.content}>
        {section === 'library' && <LibrarySection />}
        {section === 'providers' && <ProvidersSection />}
        {section === 'collection' && <CollectionSection />}
        {section === 'system' && <SystemSection />}
      </div>
    </PageShell>
  );
}

/**
 * Library section: scan roots, tag writes, genres, follow rules
 */
function LibrarySection() {
  return (
    <div className={styles.sections}>
      <section className={styles.subsection}>
        <h2 className={styles.sectionTitle}>Scan Roots</h2>
        <p className={styles.sectionDescription}>Manage the folders Liner indexes for music files</p>
        <SettingsScanRootsContent />
      </section>

      <section className={styles.subsection}>
        <h2 className={styles.sectionTitle}>Tag Writes</h2>
        <p className={styles.sectionDescription}>Control metadata writing to your music files</p>
        <SettingsTagWritesContent />
      </section>

      <section className={styles.subsection}>
        <h2 className={styles.sectionTitle}>Genres</h2>
        <p className={styles.sectionDescription}>Configure genre whitelisting and aliases</p>
        <SettingsGenresContent />
      </section>

      <section className={styles.subsection}>
        <h2 className={styles.sectionTitle}>Follow Rules</h2>
        <p className={styles.sectionDescription}>Set defaults for artist discography collection</p>
        <SettingsFollowRulesContent />
      </section>
    </div>
  );
}

/**
 * Providers section: authentication and API keys
 */
function ProvidersSection() {
  return (
    <div className={styles.pageWrapper}>
      <SettingsProvidersPage />
    </div>
  );
}

/**
 * Collection section: curated releases and follow state
 */
function CollectionSection() {
  return (
    <div className={styles.pageWrapper}>
      <CollectionPage />
    </div>
  );
}

/**
 * System section: setup checklist, updates, and jobs
 */
function SystemSection() {
  return (
    <div className={styles.sections}>
      <section className={styles.subsection}>
        <h2 className={styles.sectionTitle}>Setup Checklist</h2>
        <p className={styles.sectionDescription}>Complete initial configuration steps</p>
        <SetupChecklistContent />
      </section>

      <section className={styles.subsection}>
        <h2 className={styles.sectionTitle}>Updates</h2>
        <p className={styles.sectionDescription}>Application and worker updates</p>
        <div className={styles.pageContent}>
          <SettingsUpdatesPage />
        </div>
      </section>

      <section className={styles.subsection}>
        <h2 className={styles.sectionTitle}>Jobs</h2>
        <p className={styles.sectionDescription}>Background scan and processing jobs</p>
        <div className={styles.pageContent}>
          <JobsPage />
        </div>
      </section>
    </div>
  );
}
