/**
 * Settings is the server's (spec §3): only the sections the role may open,
 * a search above them that filters over a static index of labels. Built on
 * the pure views only (SectionNav, SettingsSearch): nothing here asks the
 * server.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import type { DropPoolView, InviteView, NamingView, OidcSettingsResponse, Role, ScanRoot, StorageOverview, UserView } from '@tagave/shared';
import { LinkButton, PageShell, SettingsGroup } from '../components/ui';
import { InviteGroup, OpenLinksGroup, PeopleGroup, PendingLinkRow, UserRow } from '../components/users/UsersList';
import { SignInServiceForm, draftFrom } from '../components/users/SignInService';
import { IntegrationsView } from '../pages/SettingsProvidersPage';
import { LidarrSettingsForm, draftOf } from '../components/LidarrSettings';
import { RunningNow, UpdateChecksView } from '../pages/SettingsUpdatesPage';
import { SystemStatusView } from '../pages/Settings/SystemStatus';
import { StorageView, TagChangeCleanupView } from '../pages/SettingsStoragePage';
import { LIDARR_VIEW } from './lidarrFixtures';
import { APP_BUILD, FEED, WORKER_OLD, WORKER_SAME } from './updatesFixtures';
import { DropPoolSettingsView } from '../components/naming/DropPoolSettings';
import { NamingSettingsView } from '../components/naming/NamingSettings';
import { MusicFoldersView } from '../pages/SettingsScanRootsPage';
import { DeletingView } from '../pages/SettingsDeletingPage';
import { TagWritingView } from '../pages/SettingsTagWritesPage';
import { FollowRulesView } from '../pages/SettingsFollowRulesPage';
import { SectionNav } from '../components/settings/SectionNav';
import { SettingsSearch } from '../components/settings/SettingsSearch';
import { ModuleSwitchView, ModulesListView, moduleLink, type ModuleRowView } from '../pages/SettingsModulesPage';
import { searchSettings } from '../pages/settingsIndex';
import { settingsNav } from '../pages/settingsSections';
import { settingsNavItems } from '../pages/settingsNavItems';
import page from '../pages/SettingsPage.module.css';

interface Args {
  role: Role;
  /** the section shown; null on the phone's list */
  section: string | null;
  /** what the search field starts with */
  query?: string;
  updateAvailable?: boolean;
  content?: ReactNode;
  /** the frame's heading when it is not the section's (a module page names the module) */
  heading?: string;
}

function ServerSettings({ role, section, query = '', updateAvailable = false, content = null, heading }: Args) {
  const [q, setQ] = useState(query);
  const visible = settingsNav(role);
  const searchable = visible.length > 1;
  const hits = searchSettings(searchable ? q : '', visible);
  const label = heading ?? visible.find((s) => s.value === section)?.label;
  return (
    <PageShell title="Settings" sticky>
      <div className={page.layout} data-view={section ? 'section' : 'list'}>
        <SectionNav
          className={page.sectionNav}
          label="Settings sections"
          items={settingsNavItems(hits, updateAvailable)}
          current={section}
          search={searchable ? <SettingsSearch value={q} onChange={setQ} /> : undefined}
          empty="No match"
        />
        <div className={page.content}>{label && <h2>{label}</h2>}{content}</div>
      </div>
    </PageShell>
  );
}

const moduleRow = (slug: string, id: string, name: string, on: boolean, hasPage: boolean): ModuleRowView =>
  ({ slug, name, state: on ? 'On' : 'Off', on, control: hasPage ? 'page' : 'switch', link: moduleLink({ id, slug, name, on, hasPage }) });
const MODULE_ROWS: ModuleRowView[] = [
  moduleRow('player', 'player', 'Player', true, true),
  moduleRow('lidarr', 'lidarr', 'Lidarr', false, true),
  moduleRow('listen-elsewhere', 'listen-links', 'Listen elsewhere', true, false),
  moduleRow('music-connections', 'mc', 'Music Connections', true, false),
  moduleRow('playlists', 'playlists', 'Playlists', true, false),
];

const noop = () => undefined;

const integrations = (
  <IntegrationsView
    settings={{ contactString: 'robin@example.com', discogsTokenSet: true, discogsTokenHint: 'a1b2', acoustidKeySet: false, acoustidKeyHint: null, fingerprintingEnabled: false }}
    contact="robin@example.com"
    onContact={noop}
    onSaveContact={noop}
    onSetSecret={noop}
    onForgetSecret={noop}
    onFingerprinting={noop}
    onLinkDiscogs={noop}
    linking={{ queued: true }}
  />
);

const modules = <>
  <ModulesListView rows={MODULE_ROWS} switchFor={(slug) => { const r = MODULE_ROWS.find((x) => x.slug === slug)!; return <ModuleSwitchView name={r.name} on={r.on} onSwitch={() => undefined} />; }} />
  {integrations}
</>;

/** Settings › Modules › Lidarr: the Module group, then Connection and Library (only while it is on). */
const lidarrPage = <>
  <SettingsGroup title="Module"><ModuleSwitchView layout="row" name="Lidarr" on meta="2 getting" onSwitch={noop} /></SettingsGroup>
  <LidarrSettingsForm view={LIDARR_VIEW} draft={draftOf(LIDARR_VIEW)} tested={null} error={null} onChange={noop} onTest={noop} onSave={noop} onDisconnect={noop} rootCheck={{ reach: 'writable', path: '/data/music/_Inbox', mountPath: '/data/music', error: null }} />
</>;
/** Lidarr off: its page holds the Module group alone. */
const lidarrOff = <>
  <SettingsGroup title="Module"><ModuleSwitchView layout="row" name="Lidarr" on={false} onSwitch={noop} /></SettingsGroup>
  <LidarrSettingsForm view={{ ...LIDARR_VIEW, enabled: false }} draft={draftOf(LIDARR_VIEW)} tested={null} error={null} onChange={noop} onTest={noop} onSave={noop} onDisconnect={noop} />
</>;

const day = (days: number) => new Date(Date.UTC(2026, 10, 16) - days * 86_400_000).toISOString();
const PEOPLE: UserView[] = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Robin', email: 'robin@example.com', role: 'owner', status: 'active', createdAt: day(200), lastSeenAt: day(0), password: true, twoFactor: true, passkeys: 1, oidc: false, isSelf: true },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Kim', email: 'kim@example.com', role: 'editor', status: 'active', createdAt: day(30), lastSeenAt: day(2), password: true, twoFactor: false, passkeys: 0, oidc: true, isSelf: false },
];
const LINKS: InviteView[] = [
  { id: '00000000-0000-4000-8000-000000000010', purpose: 'invite', email: 'sam@example.com', role: 'listener', userId: null, createdAt: day(1), expiresAt: day(-6), expired: false, createdBy: 'Robin' },
];
const OIDC: OidcSettingsResponse = {
  settings: { name: 'Pocket ID', issuer: 'https://auth.example.com', clientId: 'tagave', secretSet: true, enabled: true, joinEnabled: true, joinGroup: 'music', updatedAt: day(10) },
  redirectUri: 'https://music.example.com/api/auth/callback/oidc',
  active: true,
  secretUnreadable: false,
};
const userActions = { onRole: noop, onToggleDisabled: noop, onResetSignIn: noop, onRemove: noop };
const people = <>
  <PeopleGroup>{PEOPLE.map((u) => <UserRow key={u.id} user={u} actions={userActions} service="Pocket ID" />)}</PeopleGroup>
  <InviteGroup email="" role="listener" onEmail={noop} onRole={noop} onInvite={noop} />
  <OpenLinksGroup>{LINKS.map((i) => <PendingLinkRow key={i.id} invite={i} onRevoke={noop} />)}</OpenLinksGroup>
  <SignInServiceForm view={OIDC} draft={draftFrom(OIDC)} onChange={noop} onTest={noop} onSave={noop} />
</>;

const updates = <>
  <SettingsGroup title="Running now" after={<RunningNow app={APP_BUILD} workers={[WORKER_SAME, WORKER_OLD]} updating={false} now={Date.parse('2026-11-04T12:00:00Z')} />} />
  <UpdateChecksView feed={FEED} url="" onUrl={noop} onEnabled={noop} onSaveUrl={noop} onCheck={noop} />
</>;

const GB = 1024 ** 3;
const STORAGE: StorageOverview = {
  checkedAt: '2026-11-04T08:00:00.000Z',
  database: { totalBytes: 2 * GB, categories: [
    { key: 'library', label: 'Library', description: 'Albums, tracks and their files', bytes: 1.2 * GB, tables: [{ name: 'files', bytes: 0.8 * GB }] },
    { key: 'jobs', label: 'Background work', description: 'Queued and finished jobs', bytes: 0.3 * GB, tables: [{ name: 'job', bytes: 0.3 * GB }] },
  ] },
  folders: [
    { key: 'cache', label: 'Cache', path: '/cache', bytes: 3 * GB, files: 48211, exists: true, truncated: false, error: null },
    { key: 'backups', label: 'Backups', path: '/backups', bytes: 5 * GB, files: 12, exists: true, truncated: false, error: null },
  ],
  disk: {
    status: 'pass', warnPct: 85, failPct: 95, checkedAt: '2026-11-04T08:00:00.000Z',
    filesystems: [{ totalBytes: 100 * GB, usedBytes: 40 * GB, freeBytes: 60 * GB, usedPct: 40, status: 'pass', paths: [{ key: 'backups', label: 'Backups', path: '/backups' }, { key: 'cache', label: 'Cache', path: '/cache' }] }],
    unmeasured: [{ key: 'database', label: 'Database', path: null, reason: 'Postgres runs in its own container' }],
  },
};
const status = <>
  <SystemStatusView
    data={{ ok: true, checkedAt: '2026-11-04T08:00:00.000Z', checks: [
      { id: 'database', title: 'Database', status: 'pass', detail: 'Postgres 17' },
      { id: 'contact', title: 'Contact', status: 'warn', detail: 'Not set', remediation: 'Set it in Settings › Modules › Integrations.' },
    ] }}
    onRecheck={noop}
  />
  <StorageView
    data={STORAGE}
    onRefresh={noop}
    cleanup={<TagChangeCleanupView scope="archived" onScope={noop} preview={{ scope: 'archived', plans: 3, bytes: 4 * 1024 * 1024, revertible: { plans: 1, bytes: 1024 * 1024 } }} onRun={noop} />}
  />
</>;
const at = '2026-11-01T10:00:00.000Z';
const root = (over: Partial<ScanRoot>): ScanRoot => ({
  id: '11111111-1111-4111-8111-111111111111', libraryId: '22222222-2222-4222-8222-222222222222', path: '/music', displayName: 'Music',
  writable: true, enabled: true, pollIntervalS: 21600, validationStatus: 'ok', validationMessage: null, probeWritable: true,
  lastScanAt: at, lastStatus: 'done', albumsFound: 1204, tracksFound: 14873, folderLink: 'smb://192.0.2.10/music/', createdAt: at, updatedAt: at, ...over,
});
const ROOTS: ScanRoot[] = [
  root({}),
  root({ id: '33333333-3333-4333-8333-333333333333', path: '/archive', displayName: 'Archive', writable: false, probeWritable: false, folderLink: null, albumsFound: 88, tracksFound: 901 }),
];
const NAMING: NamingView = {
  rules: { folder: '{albumartist}/{year} {album}', file: '{disc}{track:02} {title}', special: [{ when: 'compilation', folder: 'Compilations/{album}' }], leaveAlone: ['_Unsorted'] },
  saved: true,
  detected: null,
  examples: [{ albumId: '44444444-4444-4444-8444-444444444444', from: 'Robin/Songs/01.flac', to: 'Robin/2019 Songs/01 Morning.flac' }],
  problems: {},
};
const POOL: DropPoolView = {
  enabled: true, scanRootId: ROOTS[0]!.id, dirPath: '_Inbox', path: '/music/_Inbox', hostPath: null,
  roots: [{ id: ROOTS[0]!.id, path: '/music' }], counts: { waiting: 1, inbox: 3, imported: 42, skipped: 0 }, problem: null, state: 'ready',
};
const library = <>
  <MusicFoldersView roots={ROOTS} onUpdate={() => Promise.resolve(null)} onScan={noop} onCheck={noop} onRemove={noop} onAdd={() => true} />
  <NamingSettingsView view={NAMING} onSave={noop} />
  <DropPoolSettingsView view={POOL} onPut={noop} />
  <DeletingView mode="mark" trashAvailable onChange={noop} />
</>;
const tagWriting = (
  <TagWritingView
    enabled
    writable={['/music']}
    policy={{ preset: 'canonical_ids_and_fill', id3Version: '2.3', multiValueSeparator: '; ' }}
    separator=" / "
    onWrites={noop}
    onPolicy={noop}
    onSeparator={noop}
    onSaveSeparator={noop}
    policyStatus={{ state: 'saved' }}
    canEditFolders
    editFolders={<LinkButton variant="secondary" size="sm" to="/settings/library">Edit</LinkButton>}
  />
);
const followRules = (
  <FollowRulesView
    rules={{ includePrimary: ['Album', 'EP'], excludeSecondary: ['Live', 'Remix'], autoFollowMinAlbums: 2 }}
    autoFollow={3}
    onRules={noop}
    onAutoFollow={noop}
    onSaveAutoFollow={noop}
  />
);

const meta = {
  title: 'Settings/Server',
  component: ServerSettings,
  tags: ['!autodocs'],
  args: { role: 'owner', section: 'modules' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Settings: the server’s sections only (an editor sees Tag writing and Follow rules). The search filters the list by section and row labels; a hit lists the labels it matched. Each section is its one heading, then groups.',
      },
    },
  },
} satisfies Meta<typeof ServerSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

/** tags inline on each story: the indexer reads them statically */
const phone = { globals: { viewport: { value: 'phone' } } } satisfies Story;

/** Every section, Modules open with Integrations under the list. */
export const Owner: Story = { tags: ['viewport-1440'], args: { role: 'owner', section: 'modules', content: modules } };
/** Tag writing first, nothing of the owner's. */
export const Editor: Story = { tags: ['viewport-1440'], args: { role: 'editor', section: 'tag-writing' } };
/** `drop` finds Library by its Drop pool row. */
export const SearchHit: Story = { name: 'Search hit', tags: ['viewport-1440'], args: { role: 'owner', section: 'library', query: 'drop' } };
export const NoMatch: Story = { name: 'No match', tags: ['viewport-1440'], args: { role: 'owner', section: 'library', query: 'zzz' } };
/** The owner's update dot stays on Updates. */
export const UpdateOnUpdates: Story = { name: 'Update on Updates', tags: ['viewport-1440'], args: { role: 'owner', section: 'updates', updateAvailable: true } };

/** Library: a group per music folder, then Naming, Drop pool and Deleting. */
export const Library: Story = { tags: ['viewport-1440'], args: { role: 'owner', section: 'library', content: library } };
/** Tag writing: Tag writes Off and On, the policy's choices saved at once, the separator typed. */
export const TagWriting: Story = { name: 'Tag writing', tags: ['viewport-1440'], args: { role: 'owner', section: 'tag-writing', content: tagWriting } };
/** Follow rules: a tick saves, Auto-follow at waits for its Save. */
export const FollowRules: Story = { name: 'Follow rules', tags: ['viewport-1440'], args: { role: 'editor', section: 'following', content: followRules } };

/** People: People, Invite, Open links, then the sign-in service's two groups. */
export const People: Story = { tags: ['viewport-1440'], args: { role: 'owner', section: 'people', content: people } };
/** Settings › Modules › Lidarr: the frame names the module; Module, Connection, Library. */
export const ModulePage: Story = { name: 'Module page', tags: ['viewport-1440'], args: { role: 'owner', section: 'modules', heading: 'Lidarr', content: lidarrPage } };
/** Lidarr off: the Module group alone, nothing else of Lidarr. */
export const ModulePageOff: Story = { name: 'Module page, off', tags: ['viewport-1440'], args: { role: 'owner', section: 'modules', heading: 'Lidarr', content: lidarrOff } };
/** Updates: Running now, Update checks. */
export const Updates: Story = { tags: ['viewport-1440'], args: { role: 'owner', section: 'updates', content: updates } };
/** Status: System status, then Storage, Database, Folders, Free space, Tag change cleanup. */
export const Status: Story = { tags: ['viewport-1440'], args: { role: 'owner', section: 'status', content: status } };

export const PhoneOwner: Story = { ...phone, name: 'Phone, owner', tags: ['phone'], args: { role: 'owner', section: null } };
export const PhoneEditor: Story = { ...phone, name: 'Phone, editor', tags: ['phone'], args: { role: 'editor', section: null } };
export const PhoneSearchHit: Story = { ...phone, name: 'Phone, search hit', tags: ['phone'], args: { role: 'owner', section: null, query: 'drop' } };
export const PhoneNoMatch: Story = { ...phone, name: 'Phone, no match', tags: ['phone'], args: { role: 'owner', section: null, query: 'zzz' } };
export const PhoneUpdateOnUpdates: Story = { ...phone, name: 'Phone, update on Updates', tags: ['phone'], args: { role: 'owner', section: null, updateAvailable: true } };
export const PhoneLibrary: Story = { ...phone, name: 'Phone, Library', tags: ['phone'], args: { role: 'owner', section: 'library', content: library } };
export const PhoneTagWriting: Story = { ...phone, name: 'Phone, Tag writing', tags: ['phone'], args: { role: 'owner', section: 'tag-writing', content: tagWriting } };
export const PhoneFollowRules: Story = { ...phone, name: 'Phone, Follow rules', tags: ['phone'], args: { role: 'editor', section: 'following', content: followRules } };
export const PhoneModules: Story = { ...phone, name: 'Phone, Modules', tags: ['phone'], args: { role: 'owner', section: 'modules', content: modules } };
export const PhonePeople: Story = { ...phone, name: 'Phone, People', tags: ['phone'], args: { role: 'owner', section: 'people', content: people } };
export const PhoneModulePage: Story = { ...phone, name: 'Phone, module page', tags: ['phone'], args: { role: 'owner', section: 'modules', heading: 'Lidarr', content: lidarrPage } };
export const PhoneUpdates: Story = { ...phone, name: 'Phone, Updates', tags: ['phone'], args: { role: 'owner', section: 'updates', content: updates } };
export const PhoneStatus: Story = { ...phone, name: 'Phone, Status', tags: ['phone'], args: { role: 'owner', section: 'status', content: status } };
