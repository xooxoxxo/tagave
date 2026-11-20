/**
 * Your settings (spec §2): the person's own settings at /you/<section>,
 * reached from their name. Everyone has Account (with Security) and
 * Appearance; a module section (Listening, DJ, Listen elsewhere,
 * Connections) is listed while its module is on. A link to one that is off
 * shows the value Off, never Not available, so an old link never lands on
 * a blank page. Same layout as Settings: two panes on a desktop; on a phone
 * /you is the list and each section a page of its own.
 */
import type { ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { PageShell } from '../components/ui';
import { SectionNav } from '../components/settings/SectionNav';
import { LinkRow } from '../components/settings/LinkRow';
import { usePhoneSubpage } from '../components/appBarTitle';
import { useCan } from '../hooks/usePermissions';
import { useYouModules } from '../hooks/useYouModules';
import { CustomThemeScreen } from '../themes/ThemeSetting';
import { SettingsAccountPage } from './SettingsAccountPage';
import { SettingsSecurityPage } from './SettingsSecurityPage';
import { SettingsListeningContent } from './SettingsListeningPage';
import { SettingsDjContent } from './SettingsDjPage';
import { SettingsListenElsewhereContent } from './SettingsListenElsewherePage';
import { SettingsConnectionsContent } from './SettingsConnectionsPage';
import { YouAppearance } from './YouAppearance';
import { YOU_SECTIONS, youNav, type YouSection } from './youSections';
import styles from './SettingsPage.module.css';
import own from './YouPage.module.css';

export function YouPage() {
  const modules = useYouModules();
  const owner = useCan('system.manage');
  const visible = youNav(modules);
  const parts = useLocation().pathname.split('/');
  // an unknown section opens the first listed one (as Settings does)
  const known = YOU_SECTIONS.find((s) => s.value === parts[2]);
  const current: YouSection = known ?? visible[0] ?? YOU_SECTIONS[0]!;
  const section = current.value;
  const view = parts[2] ? 'section' : 'list';
  // Custom theme is a part of Appearance: the way back, and the section the nav marks
  const parent = section === 'custom-theme' ? 'appearance' : section;
  usePhoneSubpage(view === 'section' ? current.label : null, parent !== section ? `/you/${parent}` : '/you');
  // a module section: true on, false off, null while it loads
  const on = current.module ? modules[current.module] : true;
  return <PageShell title="Your settings" sticky>
    <YouLayout view={view} items={visible} current={parent}>
      {on === false ? <YouModuleOff label={current.label} /> : <>
        {section === 'account' && <><h2>Account</h2><SettingsAccountPage /><h2 className={styles.modeSetting}>Security</h2><SettingsSecurityPage /></>}
        {section === 'appearance' && <><h2>Appearance</h2><YouAppearance /></>}
        {section === 'custom-theme' && <><h2>Custom theme</h2><CustomThemeScreen /></>}
        {section === 'listening' && <><h2>Listening</h2>{on && <SettingsListeningContent heading={false} />}{owner && <PlayerServerRow />}</>}
        {section === 'dj' && <><h2>DJ</h2>{on && <SettingsDjContent />}</>}
        {section === 'listen-elsewhere' && <><h2>Listen elsewhere</h2>{on && <SettingsListenElsewhereContent heading={false} />}</>}
        {section === 'connections' && <><h2>Connections</h2>{on && <SettingsConnectionsContent heading={false} />}</>}
      </>}
    </YouLayout>
  </PageShell>;
}

/**
 * The two panes (the section list, the section), or on a phone one of them:
 * `view` is `list` at /you and `section` under it. A pure view (stories).
 */
export function YouLayout({ view, items, current, children }: { view: 'list' | 'section'; items: readonly YouSection[]; current: string | null; children: ReactNode }) {
  return (
    <div className={styles.layout} data-view={view}>
      <SectionNav
        className={styles.sectionNav}
        label="Your settings sections"
        items={items.map((s) => ({ value: s.value, label: s.label, to: `/you/${s.value}` }))}
        current={current}
      />
      <div className={styles.content}>{children}</div>
    </div>
  );
}

/** A module section whose module is off: its heading and the value. */
export function YouModuleOff({ label }: { label: string }) {
  return <><h2>{label}</h2><p className={own.offValue}>Off</p></>;
}

/** The owner's player server stays in Settings › Modules › Player. */
export function PlayerServerRow() {
  return <LinkRow group="Server" label="Player server" to="/settings/modules/player" className={styles.modeSetting} />;
}
