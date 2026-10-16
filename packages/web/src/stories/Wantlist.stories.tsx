import type { Meta, StoryObj } from '@storybook/react-vite';
import type { WantlistView } from '@tagave/shared';
import { WantlistPanel } from '../components/WantlistSection';

const view: WantlistView = {
  available: true,
  suggestions: [
    { id: 's1', linkId: 'l1', service: 'review-gatherer', artist: 'Neu!', title: 'Neu! 75', releaseGroupId: null, rgMbid: null,
      reason: 'You rate Neu! and Harmonia highly, and critics rank this one first.', score: 8.5, suggestedAt: '2026-10-01T00:00:00.000Z', decision: null, decidedAt: null },
    { id: 's2', linkId: 'l1', service: 'review-gatherer', artist: 'Cluster & Eno', title: 'Cluster & Eno', releaseGroupId: null, rgMbid: null,
      reason: 'Listened to After the Heat eleven times this year.', score: null, suggestedAt: '2026-10-01T00:00:00.000Z', decision: null, decidedAt: null },
  ],
  wantlist: [{ id: 'w1', artist: 'Harmonia', title: 'Musik von Harmonia', releaseGroupId: null, releaseGroupMbid: null, discogsReleaseId: 1, dateAdded: '2026-10-03T00:00:00.000Z' }],
};

const meta = {
  title: 'Pages/Collection › Wantlist',
  component: WantlistPanel,
  tags: ['no-shot'],
  args: { view, onDecide: () => undefined },
  parameters: {
    docs: {
      description: {
        component: 'The wantlist, with suggestions from linked apps beside it. Accept tells the app that suggested it and keeps the album on the wantlist in tagave (never sent to Discogs); Dismiss tells it too. A refusal from the app (403) or a suggestion it no longer has (404) shows on the row. The reason is the other app’s, set as text.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 850, padding: 24 }}><Story /></div>],
} satisfies Meta<typeof WantlistPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Suggestions: Story = {};
export const Deciding: Story = { args: { pending: { id: 's1', decision: 'accepted' } } };
export const Refused: Story = {
  name: 'Refused by the app (403)',
  args: { errors: { s1: 'review-gatherer refused the decision (403): this connection may not send decisions. Re-approve it in Settings › Connections to grant that.' } },
};
export const Gone: Story = {
  name: 'Gone at the app (404)',
  args: { errors: { s2: 'review-gatherer no longer has this suggestion (404). It will drop off at the next sync.' } },
};
export const Empty: Story = { args: { view: { available: true, suggestions: [], wantlist: [] } } };
export const ConnectionsOff: Story = { name: 'Music Connections off', args: { view: { ...view, available: false } } };
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { errors: { s1: 'review-gatherer refused the decision (403): this connection may not send decisions.' } } };
