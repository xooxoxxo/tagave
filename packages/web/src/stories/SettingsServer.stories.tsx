/**
 * Settings is the server's (spec §3): only the sections the role may open,
 * a search above them that filters over a static index of labels. Built on
 * the pure views only (SectionNav, SettingsSearch): nothing here asks the
 * server.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import type { DropPoolView, NamingView, Role, ScanRoot } from '@tagave/shared';
import { LinkButton, PageShell } from '../components/ui';
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
}

function ServerSettings({ role, section, query = '', updateAvailable = false, content = null }: Args) {
  const [q, setQ] = useState(query);
  const visible = settingsNav(role);
  const searchable = visible.length > 1;
  const hits = searchSettings(searchable ? q : '', visible);
  const label = visible.find((s) => s.value === section)?.label;
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

const modules = <>
  <ModulesListView rows={MODULE_ROWS} switchFor={(slug) => { const r = MODULE_ROWS.find((x) => x.slug === slug)!; return <ModuleSwitchView name={r.name} on={r.on} onSwitch={() => undefined} />; }} />
  <h2 id="integrations" className={page.modeSetting}>Integrations</h2>
</>;

const noop = () => undefined;
const at = '2026-11-01T10:00:00.000Z';
const root = (over: Partial<ScanRoot>): ScanRoot => ({
  id: '11111111-1111-4111-8111-111111111111', libraryId: '22222222-2222-4222-8222-222222222222', path: '/music', displayName: 'Music',
  writable: true, enabled: true, pollIntervalS: 21600, validationStatus: 'ok', validationMessage: null, probeWritable: true,
  lastScanAt: at, lastStatus: 'done', albumsFound: 1204, tracksFound: 14873, folderLink: 'smb://music.example.com/music/', createdAt: at, updatedAt: at, ...over,
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
        component: 'Settings: the server’s sections only (an editor sees Tag writing and Follow rules). The search filters the list by section and row labels; a hit lists the labels it matched.',
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
export const Library: Story = { tags: ['viewport-1440', 'no-shot'], args: { role: 'owner', section: 'library', content: library } };
/** Tag writing: Tag writes Off and On, the policy's choices saved at once, the separator typed. */
export const TagWriting: Story = { name: 'Tag writing', tags: ['viewport-1440', 'no-shot'], args: { role: 'owner', section: 'tag-writing', content: tagWriting } };
/** Follow rules: a tick saves, Auto-follow at waits for its Save. */
export const FollowRules: Story = { name: 'Follow rules', tags: ['viewport-1440', 'no-shot'], args: { role: 'editor', section: 'following', content: followRules } };

export const PhoneOwner: Story = { ...phone, name: 'Phone, owner', tags: ['phone'], args: { role: 'owner', section: null } };
export const PhoneEditor: Story = { ...phone, name: 'Phone, editor', tags: ['phone'], args: { role: 'editor', section: null } };
export const PhoneSearchHit: Story = { ...phone, name: 'Phone, search hit', tags: ['phone'], args: { role: 'owner', section: null, query: 'drop' } };
export const PhoneNoMatch: Story = { ...phone, name: 'Phone, no match', tags: ['phone'], args: { role: 'owner', section: null, query: 'zzz' } };
export const PhoneUpdateOnUpdates: Story = { ...phone, name: 'Phone, update on Updates', tags: ['phone'], args: { role: 'owner', section: null, updateAvailable: true } };
export const PhoneLibrary: Story = { ...phone, name: 'Phone, Library', tags: ['phone', 'no-shot'], args: { role: 'owner', section: 'library', content: library } };
export const PhoneTagWriting: Story = { ...phone, name: 'Phone, Tag writing', tags: ['phone', 'no-shot'], args: { role: 'owner', section: 'tag-writing', content: tagWriting } };
export const PhoneFollowRules: Story = { ...phone, name: 'Phone, Follow rules', tags: ['phone', 'no-shot'], args: { role: 'editor', section: 'following', content: followRules } };
