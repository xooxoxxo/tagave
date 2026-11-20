/**
 * Your settings (spec §2): the person's own settings, reached from their
 * name. The section list (SectionNav) beside the section on a desktop; on a
 * phone /you is the list and each section a page of its own. Built on the
 * pure views only: nothing here asks the server.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ListeningHistoryView, ListeningView, ThemeChoice } from '@tagave/shared';
import { PageShell } from '../components/ui';
import { ThemeGallery } from '../themes/ThemePicker';
import { ListeningSettingsView } from '../pages/SettingsListeningPage';
import { PlayerServerRow, YouLayout, YouModuleOff } from '../pages/YouPage';
import { YouAppearanceView } from '../pages/YouAppearance';
import { youNav, type YouModules } from '../pages/youSections';
import page from '../pages/SettingsPage.module.css';

const noop = () => undefined;
const at = (min: number) => new Date(Date.UTC(2026, 9, 16, 19, 30) - min * 60_000).toISOString();

const NONE: YouModules = { player: false, dj: false, listenElsewhere: false, connections: false };
const ALL: YouModules = { player: true, dj: true, listenElsewhere: true, connections: true };

const listening: ListeningView = {
  playerInstalled: true,
  account: { kind: 'bundled', username: 'robin', phonePassword: true, serverScrobbles: false, state: 'active', lastError: null },
  lastfmAvailable: true,
  services: [
    { service: 'lastfm', connected: true, accountName: 'robin-fm', connectedAt: at(9000), lastOkAt: at(3), lastError: null, lastErrorAt: null, pending: 0, loves: true },
    { service: 'listenbrainz', connected: false, accountName: null, connectedAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, pending: 0, loves: false },
  ],
  lastPollAt: at(1),
  pollError: null,
};

const history: ListeningHistoryView = {
  plays: [
    { id: 'p1', title: 'Flamenco Sketches', artist: 'Miles Davis', album: 'Kind of Blue', localAlbumId: 'a', startedAt: at(3), source: 'web', scrobbles: true, scrobbled: [{ service: 'lastfm', status: 'sent', error: null }] },
    { id: 'p2', title: 'Teen Town', artist: 'Weather Report', album: 'Heavy Weather', localAlbumId: 'b', startedAt: at(600), source: 'server', scrobbles: true, scrobbled: [{ service: 'lastfm', status: 'sent', error: null }] },
  ],
  listens: [],
};

/** The toolbar's mode (data-theme on <html>). */
function useStoryDark(): boolean {
  return useSyncExternalStore((cb) => {
    const mo = new MutationObserver(cb);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, () => document.documentElement.getAttribute('data-theme') === 'dark');
}

/** Appearance with the theme gallery on local state (no saving). */
function Appearance({ canMaintain }: { canMaintain: boolean }) {
  const dark = useStoryDark();
  const [choice, setChoice] = useState<ThemeChoice>({ theme: 'classic', custom: null });
  return <>
    <h2>Appearance</h2>
    <YouAppearanceView canMaintain={canMaintain} theme={<><h2 className={page.modeSetting}>Theme</h2><ThemeGallery choice={choice} dark={dark} onPick={(theme) => setChoice((c) => ({ ...c, theme }))} /></>} />
  </>;
}

interface Args {
  modules: YouModules;
  /** the section shown; null on the phone's list */
  section: string | null;
  content?: ReactNode;
}

function YourSettings({ modules, section, content = null }: Args) {
  const current = section === 'custom-theme' ? 'appearance' : section;
  return (
    <PageShell title="Your settings" sticky>
      <YouLayout view={section ? 'section' : 'list'} items={youNav(modules)} current={current}>{content}</YouLayout>
    </PageShell>
  );
}

const meta = {
  title: 'Settings/Your settings',
  component: YourSettings,
  tags: ['!autodocs'],
  args: { modules: NONE, section: 'appearance' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Your settings: Account (with Security) and Appearance for everyone; Listening, DJ, Listen elsewhere and Connections while their module is on. A module section that is off shows the value Off.',
      },
    },
  },
} satisfies Meta<typeof YourSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

/** tags inline on each story: the indexer reads them statically */
const phone = { globals: { viewport: { value: 'phone' } } } satisfies Story;

/** Account and Appearance only; no Maintenance without library.edit. */
export const Listener: Story = { tags: ['viewport-1440'], args: { modules: NONE, section: 'appearance', content: <Appearance canMaintain={false} /> } };
/** The owner's Listening, with the link to the player server. */
export const EveryModuleOn: Story = {
  name: 'Every module on',
  tags: ['viewport-1440'],
  args: {
    modules: ALL,
    section: 'listening',
    content: <><h2>Listening</h2><ListeningSettingsView data={listening} history={history} lastfmReturn={null} onConnectLastfm={noop} onConnectListenbrainz={noop} onDisconnect={noop} onSetPhonePassword={noop} onClearPhonePassword={noop} onSaveOwnAccount={noop} onRemoveOwnAccount={noop} /><PlayerServerRow /></>,
  },
};
/** Appearance for someone who looks after the library: Maintenance stays here until Library care has it. */
export const AppearanceSection: Story = { name: 'Appearance', tags: ['viewport-1440'], args: { modules: ALL, section: 'appearance', content: <Appearance canMaintain /> } };
/** An old link to a module that is off: the value Off, never Not available. */
export const ModuleOff: Story = { name: 'Module off', tags: ['viewport-1440'], args: { modules: { ...NONE, player: true }, section: 'dj', content: <YouModuleOff label="DJ" /> } };

export const PhoneListener: Story = { ...phone, name: 'Phone, listener', tags: ['phone'], args: { modules: NONE, section: null } };
export const PhoneEveryModuleOn: Story = { ...phone, name: 'Phone, every module on', tags: ['phone'], args: { modules: ALL, section: null } };
export const PhoneAppearance: Story = { ...phone, name: 'Phone, Appearance', tags: ['phone'], args: { modules: ALL, section: 'appearance', content: <Appearance canMaintain /> } };
export const PhoneModuleOff: Story = { ...phone, name: 'Phone, module off', tags: ['phone'], args: { modules: NONE, section: 'dj', content: <YouModuleOff label="DJ" /> } };
