import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useState } from 'react';
import { AlbumMoreButton, type AlbumSummary } from '../pages/AlbumMenu';
import { AlbumActionsSheet, AlbumInfoSheet } from '../pages/AlbumSheets';
import { albumMenu, type AlbumMenuInput } from '../pages/albumActions';

const noop = () => undefined;
const summary: AlbumSummary = { coverUrl: null, title: 'Live at the Mystic', artist: 'Y&T', kicker: ['Hard Rock', '2012'], format: 'MP3 320 kbps' };
const input = (over: Partial<AlbumMenuInput> = {}): AlbumMenuInput => ({
  canCare: true,
  maintenance: false,
  shuffle: noop,
  artists: [{ id: 'a1', name: 'Y&T', go: noop }],
  ownPhysical: { pending: false, onSelect: noop },
  onInfo: noop,
  tools: [
    { key: 'reidentify', label: 'Re-identify', hint: 'Look this album up again', icon: 'tool', onSelect: noop },
    { key: 'manual', label: 'Match to a release…', hint: 'Paste a MusicBrainz or Discogs link', icon: 'tool', onSelect: noop },
    { key: 'art', label: 'Refetch cover art', icon: 'tool', onSelect: noop },
    { key: 'values', label: 'Set album values…', hint: 'Artist, title, year, genre for every track', icon: 'tool', onSelect: noop },
    { key: 'rescan', label: 'Rescan folder', icon: 'tool', separated: true, onSelect: noop },
    { key: 'asis', label: 'Keep as-is', hint: 'Keep your tags; stop identifying', icon: 'tool', separated: true, onSelect: noop },
  ],
  onToggleMaintenance: noop,
  ...over,
});

/** The drawer, open, as the album page shows it on a phone. */
function ActionsDrawer({ over }: { over?: Partial<AlbumMenuInput> }) {
  const [open, setOpen] = useState(true);
  return <AlbumActionsSheet open={open} onOpenChange={setOpen} summary={summary} model={albumMenu(input(over))} />;
}

const ABOUT = (
  <dl style={{ display: 'grid', gridTemplateColumns: '7rem 1fr', gap: '6px 12px', margin: 0 }}>
    <dt>Released</dt><dd style={{ margin: 0 }}>23 Nov 2012</dd>
    <dt>Label</dt><dd style={{ margin: 0 }}>Frontiers Records · FR CD 590</dd>
    <dt>Tracks</dt><dd style={{ margin: 0 }}>22 tracks · 2 discs · 1:58:04</dd>
    <dt>Format</dt><dd style={{ margin: 0 }}>MP3 · 320 kbps</dd>
  </dl>
);
const REVIEW = <p style={{ margin: 0 }}>Live at the Mystic is a live album by the American hard rock band Y&amp;T, recorded at the Mystic Theatre in Petaluma, California.</p>;

function InfoDrawer({ tab, side = 'bottom' }: { tab: string; side?: 'bottom' | 'right' }) {
  const [open, setOpen] = useState(true);
  return (
    <AlbumInfoSheet
      open={open}
      onOpenChange={setOpen}
      summary={summary}
      side={side}
      initialTab={tab}
      tabs={[{ value: 'about', label: 'About', content: ABOUT }, { value: 'reviews', label: 'Reviews', content: REVIEW }]}
    />
  );
}

const meta = {
  title: 'Album/More menu',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'The album\'s ⋮. On a phone or tablet a bottom drawer (Base UI Drawer: drag down, Escape or a tap outside closes it, focus stays inside and returns to ⋮): the album\'s summary, quick-action tiles, a list of rows, the Maintenance tools while Maintenance is on, and the Maintenance switch for library care. On a desktop the same items as a dropdown. Album info opens its own drawer with pill tabs (a side sheet on a desktop).',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const DrawerOwner: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <ActionsDrawer /> };
export const DrawerOwnerInMaintenance: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <ActionsDrawer over={{ maintenance: true }} /> };
export const DrawerListener: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <ActionsDrawer over={{ canCare: false }} /> };
export const DrawerNoPlayerSeveralArtists: Story = {
  tags: ['phone'],
  globals: { viewport: { value: 'phone' } },
  render: () => <ActionsDrawer over={{ shuffle: null, ownPhysical: null, artists: [{ id: 'a1', name: 'Ozzy Osbourne', go: noop }, { id: 'a2', name: 'Randy Rhoads', go: noop }] }} />,
};
export const InfoDrawerAbout: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <InfoDrawer tab="about" /> };
export const InfoDrawerReviews: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <InfoDrawer tab="reviews" /> };
export const InfoSideSheetDesktop: Story = { tags: ['shot-viewport'], render: () => <InfoDrawer tab="about" side="right" /> };

/** Desktop: the same items in the dropdown. */
export const DesktopDropdownOwner: Story = {
  tags: ['shot-viewport'],
  render: () => (
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 16 }}>
      <AlbumMoreButton place="header" drawer={false} model={albumMenu(input())} onOpen={noop} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: 'More for this album' }));
    await expect(await within(document.body).findByRole('menu')).toBeVisible();
  },
};

/** Listen elsewhere: the person's platforms in the ⋮, the inexact ones marked. */
const LISTEN: AlbumMenuInput['listen'] = [
  { platform: 'qobuz', name: 'Qobuz', url: 'https://play.qobuz.com/album/0634904078164', kind: 'exact' },
  { platform: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb', kind: 'artist' },
  { platform: 'apple', name: 'Apple Music', url: 'https://music.apple.com/search?term=Y%26T%20Live%20at%20the%20Mystic', kind: 'search' },
];
export const DrawerListenerWithListen: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <ActionsDrawer over={{ canCare: false, listen: LISTEN }} /> };
export const DesktopDropdownWithListen: Story = {
  tags: ['shot-viewport'],
  render: () => (
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 16 }}>
      <AlbumMoreButton place="header" drawer={false} model={albumMenu(input({ canCare: false, listen: LISTEN }))} onOpen={noop} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: 'More for this album' }));
    await expect(await within(document.body).findByRole('menuitem', { name: /Listen on Qobuz/ })).toBeVisible();
  },
};
