import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlbumFlowHeader } from '../pages/AlbumFlowHeader';

const noop = () => undefined;

const meta = {
  title: 'Album/Header',
  component: AlbumFlowHeader,
  args: {
    docked: true,
    artist: 'Y&T',
    title: 'Live at the Mystic',
    glide: { x: 0, y: 0 },
    backLabel: 'Back to Albums',
    onBack: noop,
    onTop: noop,
    maintenance: false,
    onToggleMaintenance: noop,
    play: { mode: 'play', onPlay: noop, onToggle: noop },
    playDocked: true,
  },
  // the header is a zero-height sticky layer; give it its band to draw in
  decorators: [(Story) => <div style={{ position: 'relative', height: 64 }}><Story /></div>],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'The album page\'s header (vault spec "tagave - Album Page Flow"). Docked it is touching keys: back | artist + album | Maintenance; once the action strip has scrolled under it, Play docks as a fourth key, left of Maintenance (a 64px icon key). The back and Maintenance icons never move. Without a player the approved three keys stay.',
      },
    },
  },
} satisfies Meta<typeof AlbumFlowHeader>;
export default meta;
type Story = StoryObj<typeof meta>;


export const PhoneAtRest: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { docked: false, playDocked: false } };
export const PhoneDockedWithPlay: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };
export const PhoneDockedWaiting: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: { mode: 'play', disabled: true } } };
export const PhoneDockedPlaying: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: { mode: 'pause', onToggle: noop } } };
export const PhoneDockedNoPlayer: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { play: null } };
export const DesktopDockedWithPlay: Story = {};
export const DesktopDockedPlaying: Story = { args: { play: { mode: 'pause', onToggle: noop } } };
