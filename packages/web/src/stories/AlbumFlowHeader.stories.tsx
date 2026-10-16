import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlbumFlowHeader } from '../pages/AlbumFlowHeader';
import { EmbossIconButton, KebabIcon } from '../components/ui';

const noop = () => undefined;
const more = <EmbossIconButton place="header" label="More for this album"><KebabIcon /></EmbossIconButton>;

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
    end: more,
  },
  // the header is a zero-height sticky layer; give it its band to draw in
  decorators: [(Story) => <div style={{ position: 'relative', height: 64 }}><Story /></div>],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'The album page\'s header: back | album title over the artist | ⋮. Back and ⋮ are embossed header icons (EmbossIconButton, no hover outline) whose centres never move; docked, a band rises behind them and the names glide in. Play never docks here. The artist page draws the same header with its kind line over the name and Maintenance on the right.',
      },
    },
  },
} satisfies Meta<typeof AlbumFlowHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PhoneAtRest: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { docked: false } };
export const PhoneDocked: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };
export const PhoneDockedLongTitle: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { title: 'The Rise and Fall of Ziggy Stardust and the Spiders from Mars', artist: 'David Bowie' } };
export const DesktopDocked: Story = {};
export const ArtistPageMaintenanceOn: Story = { args: { end: undefined, artist: 'Band', title: 'Y&T', titleFirst: false, maintenance: true, onToggleMaintenance: noop } };
