/**
 * Settings is the server's (spec §3): only the sections the role may open,
 * a search above them that filters over a static index of labels. Built on
 * the pure views only (SectionNav, SettingsSearch): nothing here asks the
 * server.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import type { Role } from '@tagave/shared';
import { PageShell } from '../components/ui';
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
        <div className={page.content}>{content ?? (label && <h2>{label}</h2>)}</div>
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
  <h2>Modules</h2>
  <ModulesListView rows={MODULE_ROWS} switchFor={(slug) => { const r = MODULE_ROWS.find((x) => x.slug === slug)!; return <ModuleSwitchView name={r.name} on={r.on} onSwitch={() => undefined} />; }} />
  <h2 id="integrations" className={page.modeSetting}>Integrations</h2>
</>;

const meta = {
  title: 'Settings/Server',
  component: ServerSettings,
  tags: ['!autodocs'],
  args: { role: 'owner', section: 'modules' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Settings: the server’s sections only (an editor sees Tag writing, Genre mapping, Follow rules and Background activity). The search filters the list by section and row labels; a hit lists the labels it matched.',
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

export const PhoneOwner: Story = { ...phone, name: 'Phone, owner', tags: ['phone'], args: { role: 'owner', section: null } };
export const PhoneEditor: Story = { ...phone, name: 'Phone, editor', tags: ['phone'], args: { role: 'editor', section: null } };
export const PhoneSearchHit: Story = { ...phone, name: 'Phone, search hit', tags: ['phone'], args: { role: 'owner', section: null, query: 'drop' } };
export const PhoneNoMatch: Story = { ...phone, name: 'Phone, no match', tags: ['phone'], args: { role: 'owner', section: null, query: 'zzz' } };
export const PhoneUpdateOnUpdates: Story = { ...phone, name: 'Phone, update on Updates', tags: ['phone'], args: { role: 'owner', section: null, updateAvailable: true } };
