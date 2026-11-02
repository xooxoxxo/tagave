import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { OidcSettingsResponse } from '@tagave/shared';
import { SignInServiceForm, draftFrom } from '../components/users/SignInService';
import { OidcLinkPanel } from '../components/users/OidcLinkSection';
import { InviteFormView } from '../pages/InvitePage';

const noop = () => undefined;
const configured: OidcSettingsResponse = {
  settings: { name: 'Zitadel', issuer: 'https://auth.example.com', clientId: '293847561928374', secretSet: true, enabled: true, joinEnabled: true, joinGroup: 'music', updatedAt: '2026-11-02T10:00:00Z' },
  redirectUri: 'https://music.example.com/api/auth/callback/oidc',
  active: true,
  secretUnreadable: false,
};
const empty: OidcSettingsResponse = { settings: null, redirectUri: configured.redirectUri, active: false, secretUnreadable: false };

function Form({ view }: { view: OidcSettingsResponse }) {
  const [draft, setDraft] = useState(draftFrom(view));
  return (
    <div style={{ maxWidth: 640, padding: 24 }}>
      <SignInServiceForm view={view} draft={draft} onChange={setDraft} onTest={noop} onSave={noop} />
    </div>
  );
}

const meta = {
  title: 'Components/Sign-in service',
  component: Form,
  // No screenshot baselines yet: render them on the CI runner (DESIGN.md) and drop `no-shot`.
  tags: ['no-shot'],
  args: { view: configured },
  parameters: {
    docs: {
      description: {
        component: 'Sign in with your own login service (OpenID Connect): the owner\'s settings in Settings › Users (the secret shown only as set), each person\'s link in Settings › Account, and the invite page\'s second way to accept.',
      },
    },
  },
} satisfies Meta<typeof Form>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Settings: Story = {};
export const SettingsEmpty: Story = { args: { view: empty } };
export const SettingsNotReachable: Story = { args: { view: { ...configured, active: false, secretUnreadable: true } } };

export const AccountNotLinked: Story = {
  render: () => <div style={{ maxWidth: 640, padding: 24 }}><OidcLinkPanel view={{ name: 'Zitadel', linked: false, linkedAt: null, canUnlink: false }} onLink={noop} onUnlink={noop} /></div>,
};

export const AccountLinked: Story = {
  render: () => <div style={{ maxWidth: 640, padding: 24 }}><OidcLinkPanel view={{ name: 'Zitadel', linked: true, linkedAt: '2026-11-02T10:00:00Z', canUnlink: true }} onLink={noop} onUnlink={noop} /></div>,
};

export const AccountOnlyWayIn: Story = {
  render: () => <div style={{ maxWidth: 640, padding: 24 }}><OidcLinkPanel view={{ name: 'Zitadel', linked: true, linkedAt: '2026-11-02T10:00:00Z', canUnlink: false }} onLink={noop} onUnlink={noop} /></div>,
};

export const InviteWithService: Story = {
  render: () => (
    <div style={{ maxWidth: 560, padding: 24 }}>
      <InviteFormView
        link={{ purpose: 'invite', email: 'kim@example.com', role: 'listener', name: null, expiresAt: '2026-11-09T00:00:00Z', clearSecondFactors: false }}
        onSubmit={noop}
        oidcName="Zitadel"
        onOidc={noop}
      />
    </div>
  ),
};
