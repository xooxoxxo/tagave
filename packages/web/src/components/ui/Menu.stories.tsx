import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Menu } from './Menu';

const items = [
  { key: 'edit', label: 'Edit tags', onSelect: () => undefined },
  { key: 'identify', label: 'Identify again', hint: 'Looks the album up on MusicBrainz', onSelect: () => undefined },
  { key: 'mb', label: 'Open on MusicBrainz', href: 'https://musicbrainz.org/' },
  { key: 'locked', label: 'Split into discs', hint: 'Needs two or more discs', disabled: true },
  { key: 'delete', label: 'Remove from library', tone: 'danger' as const, separated: true, onSelect: () => undefined },
];

const meta = {
  title: 'Components/Menu',
  component: Menu,
  tags: ['shot-viewport'],
  parameters: { layout: 'centered', docs: { story: { inline: false, iframeHeight: 380 }, description: { component: 'The "⋯" menu: a clear bubble that opens a glass list of actions for one object. Use it for secondary actions that would crowd the view; keep the primary action visible. Arrow keys, Home and End move, Enter picks, Escape or a click outside closes and focus returns to the trigger. On a phone it opens as a bottom sheet.' } } },
  args: { label: 'More for this album', items },
} satisfies Meta<typeof Menu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = {
  args: { heading: 'Kind of Blue' },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: 'More for this album' }));
    await expect(await within(document.body).findByRole('menu')).toBeVisible();
  },
};

export const OpenOnPhone: Story = {
  tags: ['phone'],
  globals: { viewport: { value: 'phone' } },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: 'More for this album' }));
  },
};

export const LongLabels: Story = {
  args: { items: [{ key: 'a', label: 'Write the album artist to every file in this folder', hint: 'Twelve files, four different tags today', onSelect: () => undefined }, ...items.slice(0, 2)] },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: 'More for this album' }));
  },
};

/** The small trigger (36px; 44px on touch), beside a small button such as the album's Play. No baseline yet: render it on CI and drop `no-shot`. */
export const Small: Story = { tags: ['no-shot'], args: { size: 'sm' } };
