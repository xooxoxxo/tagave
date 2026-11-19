/**
 * The sidebar names the person at its top: the mark, "tagave" (Settings ›
 * Appearance can hide it), search when it sits beside, and the monogram,
 * which opens the person's menu (Your settings, Settings, Sign out). Browse
 * follows, then Care for those who look after the library; nothing at the
 * foot. On a phone the bar keeps the mark, the page's name, search and the
 * menu key; its sheet lists the same things in the same order.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PlayerBarView } from '../components/PlayerBar';
import { PageShell } from '../components/ui';
import { DesktopFrame, OWNER, type FramePerson } from './DesktopFrame';

interface Args {
  person: FramePerson;
  showWordmark?: boolean;
  searchPlacement?: 'below' | 'beside';
  /** phone: the menu sheet open */
  sheetOpen?: boolean;
}

const noop = () => undefined;

function InTheApp({ person, showWordmark = true, searchPlacement = 'below', sheetOpen = false }: Args) {
  const dock = (
    <PlayerBarView
      title="" artist="" album="" coverUrl={null}
      status="idle" position={0} duration={null} volume={0.8}
      canPrevious={false} canNext={false} empty
      onToggle={noop} onPrevious={noop} onNext={noop} onSeek={noop} onVolume={noop} onRetry={noop} onQueue={noop}
    />
  );
  return (
    <DesktopFrame empty dock={dock} person={person} showWordmark={showWordmark} searchPlacement={searchPlacement} sheetOpen={sheetOpen}>
      <PageShell title="Albums"><p>Albums</p></PageShell>
    </DesktopFrame>
  );
}

const EDITOR: FramePerson = { name: 'Deniz', email: 'editor@example.com', canCare: true, owner: false, taskCount: 3 };
const LISTENER: FramePerson = { name: 'Sam', email: 'listener@example.com', canCare: false, owner: false };
const LONG: FramePerson = { ...OWNER, name: 'Deniz Kaya-Okafor Lindqvist-Montgomery of the Long Household Name', email: 'deniz.kaya-okafor@a-long-household-domain.example' };

const meta = {
  title: 'Components/Sidebar/Identity',
  component: InTheApp,
  tags: ['!autodocs'],
  args: { person: { ...OWNER, updateAvailable: true } },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof InTheApp>;
export default meta;
type Story = StoryObj<typeof meta>;

/** tags inline on each story: the indexer reads them statically */
const phone = { globals: { viewport: { value: 'phone' } } } satisfies Story;

export const OwnerWithUpdate: Story = { name: 'Owner with update', tags: ['viewport-1440'] };
export const EditorWithTasks: Story = { name: 'Editor with 3 open tasks', tags: ['viewport-1440'], args: { person: EDITOR } };
/** No Care group; the menu has Your settings and Sign out. */
export const Listener: Story = { tags: ['viewport-1440'], args: { person: LISTENER } };
export const WordmarkHidden: Story = { name: 'Wordmark hidden', tags: ['viewport-1440'], args: { showWordmark: false } };
export const SearchBeside: Story = { name: 'Search beside', tags: ['viewport-1440'], args: { searchPlacement: 'beside' } };
/** The name truncates; the monogram keeps its place at the row's end. */
export const LongName: Story = { name: 'Long name', tags: ['viewport-1440'], args: { person: LONG } };

export const PhoneOwnerWithUpdate: Story = { ...phone, name: 'Phone, owner with update', tags: ['phone'], args: { sheetOpen: true } };
export const PhoneEditorWithTasks: Story = { ...phone, name: 'Phone, editor with 3 open tasks', tags: ['phone'], args: { person: EDITOR, sheetOpen: true } };
export const PhoneListener: Story = { ...phone, name: 'Phone, listener', tags: ['phone'], args: { person: LISTENER, sheetOpen: true } };
export const PhoneWordmarkHidden: Story = { ...phone, name: 'Phone, wordmark hidden', tags: ['phone'], args: { showWordmark: false, sheetOpen: true } };
export const PhoneLongName: Story = { ...phone, name: 'Phone, long name', tags: ['phone'], args: { person: LONG, sheetOpen: true } };
