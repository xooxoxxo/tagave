import type { Meta, StoryObj } from '@storybook/react-vite';
import type { McLinkView } from '@tagave/shared';
import { ConnectionsPanel } from '../pages/SettingsConnectionsPage';

const now = Date.parse('2026-10-16T10:00:00Z');
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

const linked: McLinkView = {
  id: '6f1c2a3e-0000-4000-8000-000000000001',
  remoteUrl: 'http://192.168.1.20:8080',
  service: 'review-gatherer',
  state: 'active',
  capabilities: [
    { capability: 'critic-scores', status: 'granted', applied: 412, skipped: 0 },
    { capability: 'identity', status: 'granted', applied: 37, skipped: 2 },
    { capability: 'wantlist-suggestions', status: 'not_granted', applied: null, skipped: null },
  ],
  lastSyncAt: iso(6 * 60_000),
  lastAttemptAt: iso(6 * 60_000),
  lastError: null,
  failures: 0,
  nextAttemptAt: null,
  down: false,
  createdAt: iso(9 * 86_400_000),
};

const view = (links: McLinkView[]) => ({ links, ownUrl: 'http://192.168.1.10:3000' });

const meta = {
  title: 'Pages/Settings › Connections',
  component: ConnectionsPanel,
  tags: ['no-shot'],
  args: {
    view: view([linked]),
    onAdd: () => undefined,
    onSync: () => undefined,
    onReapprove: () => undefined,
    onEditUrl: () => true,
    onRevoke: () => undefined,
    onCopy: () => undefined,
  },
  parameters: {
    docs: {
      description: {
        component: 'Settings › Connections: the Music Connections links a person made from tagave to other music apps. Each card shows what tagave reads (granted, not granted, or newly offered: re-link to grant), the last sync and error, and Sync now, Re-approve, Edit address and Revoke. After the first link, Link back gives this tagave’s address to add in the other app.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 850, padding: 24, display: 'flex', flexDirection: 'column', gap: '1.25rem' }}><Story /></div>],
} satisfies Meta<typeof ConnectionsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { view: view([]) } };
export const Linked: Story = { args: { returned: { linked: linked.id } } };
export const NeedsApproval: Story = {
  name: 'Needs approval',
  args: { view: view([{ ...linked, state: 'needs_reapproval', lastError: 'needs re-approval' }]) },
};
export const NotAnswering: Story = {
  name: 'Not answering for a day',
  args: { view: view([{ ...linked, failures: 9, down: true, lastError: 'remote timed out', lastSyncAt: iso(30 * 3600_000), nextAttemptAt: iso(-40 * 60_000) }]) },
};
export const NewCapability: Story = {
  name: 'New capability offered',
  args: { view: view([{ ...linked, capabilities: [linked.capabilities[0]!, { capability: 'identity', status: 'available', applied: null, skipped: null }] }]) },
};
export const Revoked: Story = { args: { view: view([{ ...linked, state: 'revoked', capabilities: [] }]) } };
export const Refused: Story = {
  name: 'Link refused',
  args: { view: view([]), returned: { error: 'access_denied' }, addError: 'Could not reach a Music Connections service at that address.' },
};
