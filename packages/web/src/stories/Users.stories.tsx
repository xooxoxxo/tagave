import type { Meta, StoryObj } from '@storybook/react-vite';
import type { InviteView, UserView } from '@tagave/shared';
import { InviteGroup, LinkPanel, OpenLinksGroup, PeopleGroup, PendingLinkRow, UserRow } from '../components/users/UsersList';
import { SaveStatus } from '../components/ui';

const noop = () => undefined;
const actions = { onRole: noop, onToggleDisabled: noop, onResetSignIn: noop, onRemove: noop };
const at = (days: number) => new Date(Date.UTC(2026, 9, 16) - days * 86_400_000).toISOString();

const people: UserView[] = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Ada Lindqvist', email: 'ada@example.com', role: 'owner', status: 'active', createdAt: at(200), lastSeenAt: at(0), password: true, twoFactor: true, passkeys: 2, oidc: false, isSelf: true },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Deniz Kaya', email: 'deniz@example.com', role: 'editor', status: 'active', createdAt: at(30), lastSeenAt: at(2), password: true, twoFactor: false, passkeys: 1, oidc: false, isSelf: false },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Sam Okafor', email: 'sam@example.com', role: 'listener', status: 'active', createdAt: at(3), lastSeenAt: null, password: true, twoFactor: false, passkeys: 0, oidc: false, isSelf: false },
  { id: '00000000-0000-4000-8000-000000000004', name: 'Robin Moreau', email: 'robin@example.com', role: 'listener', status: 'disabled', createdAt: at(90), lastSeenAt: at(40), password: true, twoFactor: true, passkeys: 0, oidc: false, isSelf: false },
  { id: '00000000-0000-4000-8000-000000000005', name: 'Former housemate', email: '', role: 'listener', status: 'removed', createdAt: at(300), lastSeenAt: null, password: false, twoFactor: false, passkeys: 0, oidc: false, isSelf: false },
];

const links: InviteView[] = [
  { id: '00000000-0000-4000-8000-000000000010', purpose: 'invite', email: 'kim@example.com', role: 'listener', userId: null, createdAt: at(1), expiresAt: at(-6), expired: false, createdBy: 'Ada Lindqvist' },
  { id: '00000000-0000-4000-8000-000000000011', purpose: 'reset', email: 'deniz@example.com', role: 'editor', userId: people[1]!.id, createdAt: at(8), expiresAt: at(1), expired: true, createdBy: 'Ada Lindqvist' },
];

function People() {
  return <PeopleGroup>{people.map((u) => <UserRow key={u.id} user={u} actions={actions} />)}</PeopleGroup>;
}

const meta = {
  title: 'Components/Users',
  component: People,
  // No screenshot baselines yet: render them on the CI runner (DESIGN.md) and drop `no-shot`.
  tags: ['no-shot'],
  parameters: {
    docs: {
      description: {
        component: 'Settings › People, the drawn parts as settings groups: People (a person: name, email, how they sign in, last visit, role and the owner\'s menu; a role saves when changed), Invite (an action), Open links, and the one-time link panel shown right after an invite or set-password link is made. SettingsUsersPage wires them to the API.',
      },
    },
  },
} satisfies Meta<typeof People>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PeopleList: Story = {};

export const OpenLinks: Story = {
  render: () => <OpenLinksGroup>{links.map((i) => <PendingLinkRow key={i.id} invite={i} onRevoke={noop} />)}</OpenLinksGroup>,
};

/** A role just changed: ✓ Saved in People's head. */
export const RoleSaved: Story = {
  name: 'Role saved',
  render: () => <PeopleGroup status={<SaveStatus state="saved" />}>{people.slice(0, 3).map((u) => <UserRow key={u.id} user={u} actions={actions} />)}</PeopleGroup>,
};

export const Invite: Story = {
  render: () => <div style={{ maxWidth: 850 }}><InviteGroup email="kim@example.com" role="listener" onEmail={noop} onRole={noop} onInvite={noop} /></div>,
};

export const InviteMade: Story = {
  name: 'Invite made',
  render: () => (
    <div style={{ maxWidth: 850 }}>
      <InviteGroup email="" role="listener" onEmail={noop} onRole={noop} onInvite={noop} made={<LinkPanel title="Invite link for kim@example.com (Listener)" link="https://music.example.com/invite/Q2hhbmdlIHRoaXMgdG9rZW4gaW4gYSBzdG9yeQ" expiresAt={at(-7)} onDone={noop} />} />
    </div>
  ),
};

export const InviteLink: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <LinkPanel title="Invite link for kim@example.com (Listener)" link="https://music.example.com/invite/Q2hhbmdlIHRoaXMgdG9rZW4gaW4gYSBzdG9yeQ" expiresAt={at(-7)} onDone={noop} />
    </div>
  ),
};


export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };
export const InvitePhone: Story = { ...Invite, name: 'Invite, phone', tags: ['phone'], globals: { viewport: { value: 'phone' } } };
