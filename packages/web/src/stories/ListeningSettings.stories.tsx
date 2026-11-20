import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ListeningHistoryView, ListeningView } from '@tagave/shared';
import { ListeningSettingsView } from '../pages/SettingsListeningPage';

const at = (min: number) => new Date(Date.UTC(2026, 9, 16, 19, 30) - min * 60_000).toISOString();

const connected: ListeningView = {
  playerInstalled: true,
  account: { kind: 'bundled', username: 'robin', phonePassword: true, serverScrobbles: false, state: 'active', lastError: null },
  lastfmAvailable: true,
  services: [
    { service: 'lastfm', connected: true, accountName: 'robin-fm', connectedAt: at(9000), lastOkAt: at(3), lastError: null, lastErrorAt: null, pending: 0, loves: true },
    { service: 'listenbrainz', connected: true, accountName: 'robin', connectedAt: at(9000), lastOkAt: at(3), lastError: null, lastErrorAt: null, pending: 1, loves: false },
  ],
  lastPollAt: at(1),
  pollError: null,
};

const history: ListeningHistoryView = {
  plays: [
    { id: 'p1', title: 'Flamenco Sketches', artist: 'Miles Davis', album: 'Kind of Blue', localAlbumId: 'a', startedAt: at(3), source: 'web', scrobbles: true, scrobbled: [{ service: 'lastfm', status: 'sent', error: null }, { service: 'listenbrainz', status: 'pending', error: null }] },
    { id: 'p2', title: 'All Blues', artist: 'Miles Davis', album: 'Kind of Blue', localAlbumId: 'a', startedAt: at(15), source: 'web', scrobbles: true, scrobbled: [{ service: 'lastfm', status: 'sent', error: null }, { service: 'listenbrainz', status: 'sent', error: null }] },
    { id: 'p3', title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue', localAlbumId: 'a', startedAt: at(26), source: 'web', scrobbles: false, scrobbled: [] },
    { id: 'p4', title: 'Teen Town', artist: 'Weather Report', album: 'Heavy Weather', localAlbumId: 'b', startedAt: at(600), source: 'server', scrobbles: true, scrobbled: [{ service: 'lastfm', status: 'sent', error: null }, { service: 'listenbrainz', status: 'sent', error: null }] },
  ],
  listens: [{ id: 'l1', localAlbumId: 'a', album: 'Kind of Blue', artist: 'Miles Davis', startedAt: at(40), endedAt: at(3), tracksHeard: 4, tracksTotal: 5 }],
};

const meta = {
  title: 'Pages/Settings › Modules › Player',
  component: ListeningSettingsView,
  tags: ['no-shot'],
  args: {
    data: connected,
    history,
    lastfmReturn: null,
    onConnectLastfm: () => undefined,
    onConnectListenbrainz: () => undefined,
    onDisconnect: () => undefined,
    onSetPhonePassword: () => undefined,
    onClearPhonePassword: () => undefined,
    onSaveOwnAccount: () => undefined,
    onRemoveOwnAccount: () => undefined,
  },
  parameters: {
    docs: {
      description: {
        component: 'Your settings › Listening, each person’s own: three groups. Player account (on the bundled player the user name and a phone password, a secret with its own Set, Replace and Forget; on the owner’s server the shared account or an own login, whose User name, Password and Server scrobbles save with one Save), Scrobbling (Last.fm by web sign-in, ListenBrainz by a pasted token, what was last sent, Loves saved when changed) and Recently played. Never shows a password, token or session key.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 760, padding: 24 }}><Story /></div>],
} satisfies Meta<typeof ListeningSettingsView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {};
export const NothingConnected: Story = {
  name: 'Nothing connected yet',
  args: {
    data: { ...connected, account: { ...connected.account, phonePassword: false }, services: connected.services.map((s) => ({ ...s, connected: false, accountName: null, lastOkAt: null, pending: 0 })) },
    history: { plays: [], listens: [] },
  },
};
export const NoLastfmKey: Story = {
  name: 'Last.fm not set up by the owner',
  args: { data: { ...connected, lastfmAvailable: false, services: connected.services.map((s) => (s.service === 'lastfm' ? { ...s, connected: false, accountName: null } : s)) } },
};
export const ScrobbleProblem: Story = {
  name: 'A scrobble problem',
  args: {
    data: { ...connected, services: connected.services.map((s) => (s.service === 'lastfm' ? { ...s, lastError: 'Last.fm no longer accepts this connection; connect again', lastErrorAt: at(2), pending: 3 } : s)) },
  },
};
export const BackFromLastfm: Story = { name: 'Back from Last.fm', args: { lastfmReturn: 'connected', lastfmQueued: 12 } };
export const ListenbrainzJustConnected: Story = { name: 'ListenBrainz just connected', args: { listenbrainzQueued: 12 } };
export const SharedAccount: Story = {
  name: 'Own server, shared account',
  args: { data: { ...connected, account: { kind: 'shared', username: null, phonePassword: false, serverScrobbles: false, state: null, lastError: null } } },
};
export const OwnLogin: Story = {
  name: 'Own server, own login that scrobbles',
  args: { data: { ...connected, account: { kind: 'own', username: 'robin', phonePassword: false, serverScrobbles: true, state: 'active', lastError: null } } },
};

const shared = { kind: 'shared', username: null, phonePassword: false, serverScrobbles: false, state: null, lastError: null } as const;
const notSetUp = { ...connected, lastfmAvailable: false, services: connected.services.map((s) => ({ ...s, connected: false, accountName: null, lastOkAt: null, pending: 0 })) };

/** Desktop and phone, side by side in the story list. */
export const DesktopSharedAccount: Story = { name: 'Desktop, shared account', tags: ['viewport-1440', 'no-shot'], args: { data: { ...connected, account: shared } } };
export const DesktopOwnLogin: Story = { name: 'Desktop, own login', tags: ['viewport-1440', 'no-shot'], args: { data: { ...connected, account: { kind: 'own', username: 'robin', phonePassword: false, serverScrobbles: true, state: 'active', lastError: null } } } };
export const DesktopLastfmConnected: Story = { name: 'Desktop, Last.fm connected, Loves saved', tags: ['viewport-1440', 'no-shot'], args: { saves: { loves: { state: 'saved' } } } };
export const DesktopNotSetUp: Story = { name: 'Desktop, Last.fm not set up', tags: ['viewport-1440', 'no-shot'], args: { data: notSetUp, history: { plays: [], listens: [] } } };
export const PhoneSharedAccount: Story = { name: 'Phone, shared account', tags: ['phone', 'no-shot'], globals: { viewport: { value: 'phone' } }, args: { data: { ...connected, account: shared } } };
export const PhoneOwnLogin: Story = { name: 'Phone, own login', tags: ['phone', 'no-shot'], globals: { viewport: { value: 'phone' } }, args: { data: { ...connected, account: { kind: 'own', username: 'robin', phonePassword: false, serverScrobbles: true, state: 'active', lastError: null } } } };
export const PhoneLastfmConnected: Story = { name: 'Phone, Last.fm connected', tags: ['phone', 'no-shot'], globals: { viewport: { value: 'phone' } }, args: {} };
export const PhoneNotSetUp: Story = { name: 'Phone, Last.fm not set up', tags: ['phone', 'no-shot'], globals: { viewport: { value: 'phone' } }, args: { data: notSetUp, history: { plays: [], listens: [] } } };
