/**
 * Your settings (spec §2): the person's own settings, reached from their
 * name. The section list (SectionNav) beside the section on a desktop; on a
 * phone /you is the list and each section a page of its own. Built on the
 * pure views only: nothing here asks the server.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ListeningHistoryView, ListeningView, ThemeChoice } from '@tagave/shared';
import { PageShell } from '../components/ui';
import { ThemeGallery } from '../themes/ThemePicker';
import { ThemeGroup } from '../themes/ThemeSetting';
import { AccountView } from '../pages/SettingsAccountPage';
import { SecurityView } from '../pages/SettingsSecurityPage';
import { OidcLinkPanel } from '../components/users/OidcLinkSection';
import type { SecurityStatus } from '../pages/securityModel';
import { ListeningSettingsView } from '../pages/SettingsListeningPage';
import { PlayerServerRow, YouLayout } from '../pages/YouPage';
import { YouAppearanceView } from '../pages/YouAppearance';
import { youNav, type YouModules } from '../pages/youSections';

const noop = () => undefined;
const at = (min: number) => new Date(Date.UTC(2026, 9, 16, 19, 30) - min * 60_000).toISOString();
/** "Last sent 3 min ago" is counted from the real clock: a fixed date would read a day older each day. */
const recent = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const NONE: YouModules = { player: false, dj: false, listenElsewhere: false, connections: false };
const ALL: YouModules = { player: true, dj: true, listenElsewhere: true, connections: true };

const listening: ListeningView = {
  playerInstalled: true,
  account: { kind: 'bundled', username: 'robin', phonePassword: true, serverScrobbles: false, state: 'active', lastError: null },
  lastfmAvailable: true,
  services: [
    { service: 'lastfm', connected: true, accountName: 'robin-fm', connectedAt: at(9000), lastOkAt: recent(3), lastError: null, lastErrorAt: null, pending: 0, loves: true },
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
function Appearance() {
  const dark = useStoryDark();
  const [choice, setChoice] = useState<ThemeChoice>({ theme: 'classic', custom: null });
  return <>
    <h2>Appearance</h2>
    <YouAppearanceView theme={<ThemeGroup><ThemeGallery choice={choice} dark={dark} onPick={(theme) => setChoice((c) => ({ ...c, theme }))} /></ThemeGroup>} />
  </>;
}

const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
const security = (over: Partial<SecurityStatus> = {}): SecurityStatus => ({
  config: { publicUrl: 'http://localhost:6006', passkeysAvailable: true },
  password: { set: true, changedAt: at(40000) },
  twoFactor: { enabled: false, backupCodesLeft: null },
  passkeys: [],
  trustedDevices: [],
  ...over,
});
const protectedAccount = security({
  twoFactor: { enabled: true, backupCodesLeft: 7 },
  trustedDevices: [
    { id: 'd1', userAgent: SAFARI, ipAddress: null, createdAt: at(20000), lastUsedAt: at(5), expiresAt: new Date(Date.UTC(2026, 11, 16)).toISOString(), current: true },
    { id: 'd2', userAgent: FIREFOX, ipAddress: null, createdAt: at(30000), lastUsedAt: at(2000), expiresAt: new Date(Date.UTC(2026, 11, 2)).toISOString(), current: false },
  ],
});

/** Account: the Account group (Name typed, its one Save), the login service, then Security's groups. */
function Account({ draft = 'Robin', status = protectedAccount, securityOnly = false }: { draft?: string; status?: SecurityStatus; securityOnly?: boolean }) {
  const [client] = useState(() => new QueryClient());
  const [name, setName] = useState(draft);
  return <QueryClientProvider client={client}>
    <h2>Account</h2>
    {!securityOnly && <>
      <AccountView name="Robin" email="robin@example.com" role="editor" draft={name} onDraft={setName} onSave={noop} pending={false} state={null} detail={null} />
      <OidcLinkPanel view={{ name: 'Zitadel', linked: true, linkedAt: at(9000), canUnlink: true }} onLink={noop} onUnlink={noop} />
    </>}
    <SecurityView data={status} email="robin@example.com" />
  </QueryClientProvider>;
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
        component: 'Your settings: Account (with Security) and Appearance for everyone; Listening, DJ, Listen elsewhere and Connections while their module is on. A link to a module section that is off opens Account. Each section is one heading, then groups of rows (SettingsGroup).',
      },
    },
  },
} satisfies Meta<typeof YourSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

/** tags inline on each story: the indexer reads them statically */
const phone = { globals: { viewport: { value: 'phone' } } } satisfies Story;

/** Account and Appearance only. */
export const Listener: Story = { tags: ['viewport-1440'], args: { modules: NONE, section: 'appearance', content: <Appearance /> } };
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
/** Appearance: the same for everyone (Maintenance lives in Library care's header). */
export const AppearanceSection: Story = { name: 'Appearance', tags: ['viewport-1440'], args: { modules: ALL, section: 'appearance', content: <Appearance /> } };

/** Account: Name, Email, Role, the login service, then Security with the authenticator off. */
export const AccountSection: Story = { name: 'Account', tags: ['viewport-1440'], args: { modules: NONE, section: 'account', content: <Account status={security()} /> } };
/** A new name typed: Save is on. */
export const AccountNameChanged: Story = { name: 'Account, name changed', tags: ['viewport-1440'], args: { modules: NONE, section: 'account', content: <Account draft="Robin Doe" status={security()} /> } };
/** Security: the authenticator on, 7 backup codes left, two trusted devices. */
export const SecuritySection: Story = { name: 'Security', tags: ['viewport-1440'], args: { modules: NONE, section: 'account', content: <Account securityOnly /> } };

export const PhoneListener: Story = { ...phone, name: 'Phone, listener', tags: ['phone'], args: { modules: NONE, section: null } };
export const PhoneEveryModuleOn: Story = { ...phone, name: 'Phone, every module on', tags: ['phone'], args: { modules: ALL, section: null } };
export const PhoneAppearance: Story = { ...phone, name: 'Phone, Appearance', tags: ['phone'], args: { modules: ALL, section: 'appearance', content: <Appearance /> } };
export const PhoneAccount: Story = { ...phone, name: 'Phone, Account', tags: ['phone'], args: { modules: NONE, section: 'account', content: <Account status={security()} /> } };
export const PhoneAccountNameChanged: Story = { ...phone, name: 'Phone, Account, name changed', tags: ['phone'], args: { modules: NONE, section: 'account', content: <Account draft="Robin Doe" status={security()} /> } };
export const PhoneSecurity: Story = { ...phone, name: 'Phone, Security', tags: ['phone'], args: { modules: NONE, section: 'account', content: <Account securityOnly /> } };
