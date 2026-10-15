import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ListeningHistoryView, ListeningView } from '@tagave/shared';
import { ListeningSettingsView } from '../pages/SettingsListeningPage';

const at = (min: number) => new Date(Date.UTC(2026, 9, 16, 19, 30) - min * 60_000).toISOString();

const connected: ListeningView = {
  playerInstalled: true,
  account: { kind: 'bundled', username: 'anna', phonePassword: true, serverScrobbles: false, state: 'active', lastError: null },
  lastfmAvailable: true,
  services: [
    { service: 'lastfm', connected: true, accountName: 'anna-fm', connectedAt: at(9000), lastOkAt: at(3), lastError: null, lastErrorAt: null, pending: 0 },
    { service: 'listenbrainz', connected: true, accountName: 'anna', connectedAt: at(9000), lastOkAt: at(3), lastError: null, lastErrorAt: null, pending: 1 },
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
  title: 'Pages/Settings › Listening',
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
        component: 'Each person’s own listening settings (Settings › Your account › Listening): their account on the player (made by tagave on the bundled player, with an optional password for phone apps; or their own login on the owner’s server), Last.fm (web sign-in) and ListenBrainz (a pasted token, checked), what was last scrobbled and what failed, and their recent plays. Never shows a password, token or session key.',
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
export const BackFromLastfm: Story = { name: 'Back from Last.fm', args: { lastfmReturn: 'connected' } };
export const SharedAccount: Story = {
  name: 'Own server, shared account',
  args: { data: { ...connected, account: { kind: 'shared', username: null, phonePassword: false, serverScrobbles: false, state: null, lastError: null } } },
};
export const OwnLogin: Story = {
  name: 'Own server, own login that scrobbles',
  args: { data: { ...connected, account: { kind: 'own', username: 'anna', phonePassword: false, serverScrobbles: true, state: 'active', lastError: null } } },
};
