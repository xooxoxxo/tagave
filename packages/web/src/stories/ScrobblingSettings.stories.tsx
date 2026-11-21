import type { Meta, StoryObj } from '@storybook/react-vite';
import { ScrobblingSettingsPanel } from '../pages/SettingsPlaybackPage';

const meta = {
  title: 'Pages/Settings › Modules › Player › Scrobbling',
  component: ScrobblingSettingsPanel,
  // The older stories have no baseline yet; the settings layout's stories opt in with `!no-shot`.
  tags: ['no-shot'],
  args: {
    view: { lastfm: { configured: false, source: null, apiKeyHint: null }, listenbrainz: { available: true } },
    onSave: () => undefined,
    onRemove: () => undefined,
  },
  parameters: {
    docs: {
      description: {
        component: 'The owner’s half of scrobbling, in Settings › Modules › Player: the Last.fm API key and shared secret tagave signs scrobbles with, a secret pair with its own Save. The steps to get a key sit behind the group’s ?. With a key: Set and its last four characters, Replace and Forget. Below it, the owner’s own Last.fm connection, with Connect when it is missing (plays are only sent for people who connected). tagave checks the key with Last.fm before saving and keeps it sealed.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 760, padding: 24 }}><Story /></div>],
} satisfies Meta<typeof ScrobblingSettingsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

const ready = { lastfm: { configured: true, source: 'settings' as const, apiKeyHint: '105a' }, listenbrainz: { available: true as const } };

export const NotSetUp: Story = { name: 'Not set up' };
export const Ready: Story = { args: { view: ready, you: { lastfmAccount: 'anna-fm' } } };
export const YouNotConnected: Story = { name: 'Ready, your Last.fm not connected', args: { view: ready, you: { lastfmAccount: null }, onConnect: () => undefined } };
export const Replacing: Story = { name: 'Replace open', args: { view: ready, initialReplacing: true } };
export const FromEnv: Story = { name: 'Key from .env', args: { view: { lastfm: { configured: true, source: 'env', apiKeyHint: '77c1' }, listenbrainz: { available: true } } } };
export const Refused: Story = { args: { error: 'The shared secret does not belong to this API key' } };
export const ReadyPhone: Story = { name: 'Ready, phone', tags: ['phone', '!no-shot'], globals: { viewport: { value: 'phone' } }, args: { view: ready, you: { lastfmAccount: 'anna-fm' } } };
export const NotSetUpPhone: Story = { name: 'Not set up, phone', tags: ['phone', '!no-shot'], globals: { viewport: { value: 'phone' } } };
