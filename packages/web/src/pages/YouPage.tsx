/**
 * Your settings (spec §2): the person's own settings at /you/<section>,
 * reached from their name. Everyone has Account (with Security) and
 * Appearance; a module section (Listening, DJ, Listen elsewhere,
 * Connections) is listed while its module is on. A link to one that is off
 * goes to Account, replacing it (the modules rule: an off module shows
 * nowhere outside Settings › Modules, so never an Off value or Not
 * available); while the module loads the section shows its heading alone.
 * The section's one h2 (its nav label) is the frame's: the pages render
 * groups (SettingsGroup) under it, never a heading of their own; Account's
 * Security groups follow its Account groups. Same layout as Settings: two
 * panes on a desktop; on a phone /you is the list and each section a page
 * of its own.
 */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from '@tanstack/react-router';
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
import { YOU_SECTIONS, youGate, youNav, type YouSection } from './youSections';
import styles from './SettingsPage.module.css';

export function YouPage() {
  const modules = useYouModules();
  const owner = useCan('system.manage');
  const visible = youNav(modules);
  const location = useLocation();
  const parts = location.pathname.split('/');
  // an unknown section opens the first listed one (as Settings does)
  const known = YOU_SECTIONS.find((s) => s.value === parts[2]);
  const current: YouSection = known ?? visible[0] ?? YOU_SECTIONS[0]!;
  const section = current.value;
  const view = parts[2] ? 'section' : 'list';
  // Custom theme is a part of Appearance: the way back, and the section the nav marks
  const parent = section === 'custom-theme' ? 'appearance' : section;
  usePhoneSubpage(view === 'section' ? current.label : null, parent !== section ? `/you/${parent}` : '/you');
  // a module section: off goes to Account; while it loads, its heading alone
  const gate = youGate(section, modules);
  // the query goes along (a Connections or Last.fm return: ?linked=, ?error=, ?lastfm=)
  if (gate === '/you/account') return <Navigate to="/you/$section" params={{ section: 'account' }} search={location.search as never} hash={location.hash} replace />;
  return <PageShell title="Your settings" sticky>
    <YouLayout view={view} items={visible} current={parent}>
      <h2>{current.label}</h2>
      {gate !== 'wait' && <>
        {section === 'account' && <><SettingsAccountPage /><SettingsSecurityPage /></>}
        {section === 'appearance' && <YouAppearance />}
        {section === 'custom-theme' && <CustomThemeScreen />}
        {section === 'listening' && <><SettingsListeningContent />{owner && <PlayerServerRow />}</>}
        {section === 'dj' && <SettingsDjContent />}
        {section === 'listen-elsewhere' && <SettingsListenElsewhereContent />}
        {section === 'connections' && <SettingsConnectionsContent />}
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

/** The owner's player server stays in Settings › Modules › Player. */
export function PlayerServerRow() {
  return <LinkRow group="Server" label="Player server" to="/settings/modules/player" className={styles.modeSetting} />;
}
