import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlbumActionStrip } from '../pages/AlbumActionStrip';
import { albumActionContext } from '../pages/albumActions';
import type { MenuItem } from '../components/ui';

const artist: MenuItem = { key: 'artist-1', label: 'Go to Y&T', onSelect: () => undefined };
const ownerItems: MenuItem[] = [
  artist,
  { key: 'own', label: 'I own this on vinyl/CD', hint: 'Adds it to your physical collection and Discogs', separated: true, onSelect: () => undefined },
  { key: 'mode', label: 'Turn on Maintenance', separated: true, onSelect: () => undefined },
];
const ownerMenu = { label: 'More for this album', items: ownerItems };
const listenerMenu = { label: 'More for this album', items: [artist] };
const owner = albumActionContext({ playerInstalled: true, maintenance: false, menuItems: ownerItems.length });
const listener = albumActionContext({ playerInstalled: true, maintenance: false, menuItems: 1 });
const ownerNoPlayer = albumActionContext({ playerInstalled: false, maintenance: false, menuItems: ownerItems.length });
const NOTE = 'On the player after its first scan';
const noop = () => undefined;

const meta = {
  title: 'Album/Action strip',
  component: AlbumActionStrip,
  args: { layout: 'phone', context: owner, menu: ownerMenu, play: { mode: 'play', onPlay: noop, onToggle: noop, onShuffle: noop } },
  // the album column: the phone's 22px gutters, so Play sits on the screen's centre line
  decorators: [(Story, ctx) => (
    <div style={ctx.args.layout === 'phone' ? { padding: '24px 22px', display: 'flex', flexDirection: 'column' } : { padding: 8, display: 'flex', flexDirection: 'column', width: 560 }}>
      <Story />
    </div>
  )],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'The album page\'s actions: one strip of touching transport keys in the header keys\' style, drawn from a slot list (`SLOTS` in albumActions.ts): Shuffle | Play | ⋯. Play is icon only (its word is for screen readers); on a phone it fills the row between the two side keys, which are as wide as each other, so it sits on the screen\'s centre line; on a desktop it is 200px. Shuffle plays the album in a random order. ⋯ holds the album\'s artists for everyone, plus the physical copy and Maintenance with library care. Without a player there is no Play or Shuffle; with nothing to press there is no strip.',
      },
    },
  },
} satisfies Meta<typeof AlbumActionStrip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PhoneOwner: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };
export const PhoneListener: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { context: listener, menu: listenerMenu } };
export const PhoneWaitingForTheFirstScan: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: { mode: 'play', disabled: true, note: NOTE, onPlay: noop, onShuffle: noop } } };
export const PhonePlaying: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: { mode: 'pause', onToggle: noop, onShuffle: noop } } };
export const PhoneLoading: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: { mode: 'play', loading: true, onPlay: noop, onShuffle: noop } } };
export const PhoneNoPlayer: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { context: ownerNoPlayer, play: null } };

export const DesktopOwner: Story = { args: { layout: 'desk' } };
export const DesktopWaitingForTheFirstScan: Story = { args: { layout: 'desk', play: { mode: 'play', disabled: true, note: NOTE, onPlay: noop, onShuffle: noop } } };
export const DesktopPlaying: Story = { args: { layout: 'desk', play: { mode: 'pause', onToggle: noop, onShuffle: noop } } };
export const DesktopListener: Story = { args: { layout: 'desk', context: listener, menu: listenerMenu } };
export const DesktopNoPlayer: Story = { args: { layout: 'desk', context: ownerNoPlayer, play: null } };
