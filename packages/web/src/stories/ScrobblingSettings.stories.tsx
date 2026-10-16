import type { Meta, StoryObj } from '@storybook/react-vite';
import { ScrobblingSettingsPanel } from '../pages/SettingsPlaybackPage';

const meta = {
  title: 'Pages/Settings › Playback › Scrobbling',
  component: ScrobblingSettingsPanel,
  tags: ['no-shot'],
  args: {
    view: { lastfm: { configured: false, source: null, apiKeyHint: null }, listenbrainz: { available: true } },
    onSave: () => undefined,
    onRemove: () => undefined,
  },
  parameters: {
    docs: {
      description: {
        component: 'The owner’s half of scrobbling, in Settings › Playback: the Last.fm API key and shared secret tagave signs scrobbles with, with the steps to make them at last.fm/api/account/create. tagave checks them with Last.fm before saving and keeps them sealed. ListenBrainz needs nothing here; each person connects their own accounts in Settings › Listening.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 760, padding: 24 }}><Story /></div>],
} satisfies Meta<typeof ScrobblingSettingsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NotSetUp: Story = { name: 'Not set up' };
export const Ready: Story = { args: { view: { lastfm: { configured: true, source: 'settings', apiKeyHint: '3f9a' }, listenbrainz: { available: true } } } };
export const FromEnv: Story = { name: 'Key from .env', args: { view: { lastfm: { configured: true, source: 'env', apiKeyHint: '77c1' }, listenbrainz: { available: true } } } };
export const Refused: Story = { args: { error: 'The shared secret does not belong to this API key' } };
