import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlbumPlayRow } from '../pages/AlbumPlayRow';
import { Menu } from '../components/ui';

const menu = <Menu label="More for this album" size="sm" items={[{ key: 'own', label: 'I own this on vinyl/CD', onSelect: () => undefined }, { key: 'mode', label: 'Turn on Maintenance', separated: true, onSelect: () => undefined }]} />;

const meta = {
  title: 'Album/Play row',
  component: AlbumPlayRow,
  // No screenshot baselines yet: render them on the CI runner (DESIGN.md) and
  // drop `no-shot`. The axe scan still runs on every story.
  tags: ['no-shot'],
  args: { mode: 'play', variant: 'primary', menu, onPlay: () => undefined, onToggle: () => undefined },
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'The album page\'s Play, its ⋯ menu and, when Play has to wait, one quiet line saying why. It sits in the title area under the two detail lines, so the tracks stay close on a phone. Play is disabled while the player server\'s scan has not reached the album (it turns on by itself when the scan gets there), while the player does not answer, or when the files are missing; an album the player simply has not seen keeps Play, which asks the player to look for the files. Without a player only the menu shows; in Maintenance the menu moves to the state line.',
      },
    },
  },
} satisfies Meta<typeof AlbumPlayRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playable: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Playing: Story = { args: { mode: 'pause' } };
export const Paused: Story = { args: { mode: 'resume' } };
export const WaitingForTheFirstScan: Story = { args: { disabled: true, note: 'On the player after its first scan (34 %)' } };
export const NotAnswering: Story = { args: { disabled: true, note: 'The player is not answering right now' } };
export const NotSeenYet: Story = { args: { note: 'Not on the player yet' } };
export const NoPlayer: Story = { args: { mode: null } };
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { disabled: true, note: 'On the player after its first scan (34 %)' } };
