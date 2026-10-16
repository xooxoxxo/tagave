import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlbumActionStrip } from '../pages/AlbumActionStrip';
import { albumActionContext } from '../pages/albumActions';
import type { MenuItem } from '../components/ui';

const items: MenuItem[] = [
  { key: 'own', label: 'I own this on vinyl/CD', hint: 'Adds it to your physical collection and Discogs', onSelect: () => undefined },
  { key: 'mode', label: 'Turn on Maintenance', separated: true, onSelect: () => undefined },
];
const menu = { label: 'More for this album', items };
const owner = albumActionContext({ canCare: true, playerInstalled: true, maintenance: false });
const listener = albumActionContext({ canCare: false, playerInstalled: true, maintenance: false });
const ownerNoPlayer = albumActionContext({ canCare: true, playerInstalled: false, maintenance: false });
const NOTE = 'On the player after its first scan (34 %)';
const noop = () => undefined;

const meta = {
  title: 'Album/Action strip',
  component: AlbumActionStrip,
  args: { layout: 'phone', context: owner, menu, play: { mode: 'play', onPlay: noop, onToggle: noop } },
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
        component: 'The album page\'s actions: one strip of touching transport keys in the header keys\' style, drawn from a slot list (`SLOTS.phone` / `SLOTS.desk` in albumActions.ts). An empty slot keeps its width and draws nothing, so Play never moves: on a phone it is the wide centre key on the screen\'s centre line, with ⋯ pinned to the outer right slot; on a desktop it is a 200px key first. Like, add to playlist, share and radio are planned: their slots stay empty until they ship. Without a player there is no Play key; with nothing to press there is no strip.',
      },
    },
  },
} satisfies Meta<typeof AlbumActionStrip>;
export default meta;
type Story = StoryObj<typeof meta>;


export const PhoneOwner: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };
export const PhoneListener: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { context: listener, menu: null } };
export const PhoneWaitingForTheFirstScan: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: { mode: 'play', disabled: true, waitText: '34 %', note: NOTE, onPlay: noop } } };
export const PhonePlaying: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: { mode: 'pause', onToggle: noop } } };
export const PhoneLoading: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: { mode: 'play', loading: true, onPlay: noop } } };
export const PhoneNoPlayer: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { context: ownerNoPlayer, play: null } };

export const DesktopOwner: Story = { args: { layout: 'desk' } };
export const DesktopWaitingForTheFirstScan: Story = { args: { layout: 'desk', play: { mode: 'play', disabled: true, waitText: '34 %', note: NOTE, onPlay: noop } } };
export const DesktopPlaying: Story = { args: { layout: 'desk', play: { mode: 'pause', onToggle: noop } } };
export const DesktopListener: Story = { args: { layout: 'desk', context: listener, menu: null } };
export const DesktopNoPlayer: Story = { args: { layout: 'desk', context: ownerNoPlayer, play: null } };
