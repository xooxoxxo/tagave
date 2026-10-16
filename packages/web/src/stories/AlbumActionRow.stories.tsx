import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlbumActionRow } from '../pages/AlbumActionRow';
import { albumActionContext } from '../pages/albumActions';

const noop = () => undefined;
const NOTE = 'On the player after its first scan';

const meta = {
  title: 'Album/Action row',
  component: AlbumActionRow,
  args: { context: albumActionContext({ playerInstalled: true }), play: { mode: 'play', onPlay: noop, onToggle: noop, onShuffle: noop } },
  // the album column: the phone's 22px gutters, so Play sits on the screen's centre line
  decorators: [(Story) => <div style={{ padding: '24px 22px' }}><Story /></div>],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'The album\'s actions under its details: raised (embossed) icons only, from the slot list (`SLOTS` in albumActions.ts): Shuffle | Play | (space for an action to come). Play is the primary action by size: a larger accent glyph with the same niche on hover and the same focus ring; icon only (its word is for screen readers). The one ⋮ is in the header. While the player has not reached the album, Play and Shuffle wait and one line says why. Without a player there is no row.',
      },
    },
  },
} satisfies Meta<typeof AlbumActionRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PhoneReady: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };
export const PhonePlaying: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: { mode: 'pause', onToggle: noop, onShuffle: noop } } };
export const PhonePaused: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: { mode: 'resume', onToggle: noop, onShuffle: noop } } };
export const PhoneLoading: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: { mode: 'play', loading: true, onPlay: noop, onShuffle: noop } } };
export const PhoneWaitingForTheFirstScan: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: { mode: 'play', disabled: true, note: NOTE, onPlay: noop, onShuffle: noop } } };
export const PhonePlayFocused: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, parameters: { pseudo: { focusVisible: ['[data-album-play]'] } } };
export const PhonePlayHover: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, parameters: { pseudo: { hover: ['[data-album-play]'] } } };
export const DesktopReady: Story = {};
export const DesktopWaitingForTheFirstScan: Story = { args: { play: { mode: 'play', disabled: true, note: NOTE, onPlay: noop, onShuffle: noop } } };
