/**
 * Library care's shell (spec §4): the tabs a person sees (workTabs) and
 * Maintenance in the header. A static body: the panels fetch, so they are
 * not drawn here.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { PageShell } from '../components/ui';
import { MaintenanceControlView } from '../components/MaintenanceControl';
import { workTabs, type WorkTabsInput } from '../pages/workTabs';
import { GenreMappingView } from '../pages/SettingsGenresPage';

const noop = () => undefined;
const counts = { queue: 12, identify: 4, attention: 3, tasks: 0, inbox: 2 };
const EDITOR: WorkTabsInput = { owner: false, editor: true, lidarrOn: false, autotaggerOn: true, counts };
const OWNER: WorkTabsInput = { owner: true, editor: true, lidarrOn: true, autotaggerOn: true, counts };

interface Args {
  who: WorkTabsInput;
  tab: string;
  maintenance: boolean;
  /** the tab's body; a static line when left out */
  body?: ReactNode;
}

function LibraryCareShell({ who, tab, maintenance, body }: Args) {
  return (
    <PageShell
      title="Library care"
      tabs={workTabs(who)}
      activeTab={tab}
      onTabChange={noop}
      actions={<MaintenanceControlView on={maintenance} onChange={noop} />}
    >
      {body ?? <p>Tab body</p>}
    </PageShell>
  );
}

const meta = {
  title: 'Library care/Shell',
  component: LibraryCareShell,
  tags: ['!autodocs'],
  args: { who: EDITOR, tab: 'activity', maintenance: false },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Library care: the tabs for the person (Genre mapping and Background activity last, Getting and Autotagger only while their module is on), Maintenance Off/On in the header.',
      },
    },
  },
} satisfies Meta<typeof LibraryCareShell>;
export default meta;
type Story = StoryObj<typeof meta>;

/** tags inline on each story: the indexer reads them statically */
const phone = { globals: { viewport: { value: 'phone' } } } satisfies Story;

/** An editor on Background activity: no owner tabs. */
export const Editor: Story = { tags: ['viewport-1440'], args: { who: EDITOR, tab: 'activity' } };
/** The owner on Genre mapping: every tab. */
export const Owner: Story = { tags: ['viewport-1440'], args: { who: OWNER, tab: 'genres' } };
/** Maintenance on. */
export const MaintenanceOn: Story = { name: 'Maintenance on', tags: ['viewport-1440'], args: { who: OWNER, tab: 'review', maintenance: true } };

const genreMapping = (
  <GenreMappingView
    whitelistText={'Rock\nElectronic\nJazz'}
    aliasesText={'metal = Rock\nidm = Electronic\nnot a line'}
    maxGenres={3}
    ignored={1}
    dirty
    preview={{
      map: { whitelist: ['Rock', 'Electronic', 'Jazz'], aliases: { metal: 'Rock', idm: 'Electronic' }, maxGenres: 3 },
      histogram: [{ genre: 'Rock', albums: 412 }, { genre: 'Electronic', albums: 268 }, { genre: 'Jazz', albums: 91 }],
      tags: [
        { tag: 'rock', kind: 'genre', source: 'file', weight: null, count: 380, mappedTo: 'Rock' },
        { tag: 'idm', kind: 'style', source: 'discogs', weight: null, count: 44, mappedTo: 'Electronic' },
        { tag: 'field recording', kind: 'tag', source: 'lastfm', weight: 12, count: 0, mappedTo: null },
      ],
    }}
    onWhitelist={noop}
    onAliases={noop}
    onMaxGenres={noop}
    onSave={noop}
    onReset={noop}
  />
);
/** Genre mapping on the settings layout: the map with its one Save and Reset, then the preview's groups. */
export const GenreMapping: Story = { name: 'Genre mapping', tags: ['viewport-1440'], args: { who: OWNER, tab: 'genres', body: genreMapping } };

export const PhoneEditor: Story = { ...phone, name: 'Phone, editor', tags: ['phone'], args: { who: EDITOR, tab: 'activity' } };
export const PhoneOwner: Story = { ...phone, name: 'Phone, owner', tags: ['phone'], args: { who: OWNER, tab: 'genres' } };
export const PhoneMaintenanceOn: Story = { ...phone, name: 'Phone, Maintenance on', tags: ['phone'], args: { who: OWNER, tab: 'review', maintenance: true } };
export const PhoneGenreMapping: Story = { ...phone, name: 'Phone, Genre mapping', tags: ['phone'], args: { who: OWNER, tab: 'genres', body: genreMapping } };
