/**
 * Library care's shell (spec §4): the tabs a person sees (workTabs) and
 * Maintenance in the header. A static body: the panels fetch, so they are
 * not drawn here.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageShell } from '../components/ui';
import { MaintenanceControlView } from '../components/MaintenanceControl';
import { workTabs, type WorkTabsInput } from '../pages/workTabs';

const noop = () => undefined;
const counts = { queue: 12, identify: 4, attention: 3, tasks: 0, inbox: 2 };
const EDITOR: WorkTabsInput = { owner: false, editor: true, lidarrOn: false, autotaggerOn: true, counts };
const OWNER: WorkTabsInput = { owner: true, editor: true, lidarrOn: true, autotaggerOn: true, counts };

interface Args {
  who: WorkTabsInput;
  tab: string;
  maintenance: boolean;
}

function LibraryCareShell({ who, tab, maintenance }: Args) {
  return (
    <PageShell
      title="Library care"
      tabs={workTabs(who)}
      activeTab={tab}
      onTabChange={noop}
      actions={<MaintenanceControlView on={maintenance} onChange={noop} />}
    >
      <p>Tab body</p>
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
export const Editor: Story = { tags: ['viewport-1440', 'no-shot'], args: { who: EDITOR, tab: 'activity' } };
/** The owner on Genre mapping: every tab. */
export const Owner: Story = { tags: ['viewport-1440', 'no-shot'], args: { who: OWNER, tab: 'genres' } };
/** Maintenance on. */
export const MaintenanceOn: Story = { name: 'Maintenance on', tags: ['viewport-1440', 'no-shot'], args: { who: OWNER, tab: 'review', maintenance: true } };

export const PhoneEditor: Story = { ...phone, name: 'Phone, editor', tags: ['phone', 'no-shot'], args: { who: EDITOR, tab: 'activity' } };
export const PhoneOwner: Story = { ...phone, name: 'Phone, owner', tags: ['phone', 'no-shot'], args: { who: OWNER, tab: 'genres' } };
export const PhoneMaintenanceOn: Story = { ...phone, name: 'Phone, Maintenance on', tags: ['phone', 'no-shot'], args: { who: OWNER, tab: 'review', maintenance: true } };
