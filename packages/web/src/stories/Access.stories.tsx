import type { Meta, StoryObj } from '@storybook/react-vite';
import { NotAvailable } from '../components/access/NotAvailable';
import { InviteFormView, InviteGoneView } from '../pages/InvitePage';

const meta = {
  title: 'Components/Access',
  component: NotAvailable,
  // No screenshot baselines yet: render them on the CI runner (DESIGN.md) and drop `no-shot`.
  tags: ['no-shot'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'What a role without a page sees (a direct link to Settings › Backups for a listener): a calm note and a way back, never a broken page. `RequirePermission` and the router\'s `guarded()` render it; a Settings section renders it inline. The invite page\'s form and its "link no longer works" state are here too.',
      },
    },
  },
} satisfies Meta<typeof NotAvailable>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NotAvailablePage: Story = {};
export const NotAvailableInline: Story = { args: { inline: true } };

const expires = new Date(Date.UTC(2026, 9, 23)).toISOString();

export const InviteForm: Story = {
  render: () => (
    <div style={{ maxWidth: 560, padding: 24 }}>
      <InviteFormView link={{ purpose: 'invite', email: 'kim@example.com', role: 'listener', name: null, expiresAt: expires, clearSecondFactors: false }} onSubmit={() => undefined} />
    </div>
  ),
};

export const SetPasswordForm: Story = {
  render: () => (
    <div style={{ maxWidth: 560, padding: 24 }}>
      <InviteFormView link={{ purpose: 'reset', email: 'deniz@example.com', role: 'editor', name: 'Deniz Kaya', expiresAt: expires, clearSecondFactors: true }} onSubmit={() => undefined} />
    </div>
  ),
};

export const LinkGone: Story = { render: () => <div style={{ maxWidth: 560, padding: 24 }}><InviteGoneView /></div> };
