/**
 * Design round rr50, direction B (Qobuz): the queue lives inside the full
 * Now Playing view (desktop and phone); "Playlists" is a main page with a
 * grid of covers; Add to playlist is a cover picker; a playlist reorders in
 * an Edit mode; on a phone an edge-to-edge mini bar with play and next.
 * Previews only: nothing here is wired.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Shell } from './Shell';
import { AlbumPage, GlassList, MiniBarB, NowPlayingDesktop, NowPlayingPhone, PickerDialog, PickerDrawer, PlaylistPage, PlaylistsGrid, TrackDrawer, trackMenuRows } from './parts';
import { albumById, playlistById, trackById } from './fixtures';
import { DesktopBar, previewParams } from './stage';

const meta = {
  title: 'Previews/Queue and playlists/B Now Playing and Playlists page',
  tags: ['no-shot', '!autodocs'],
  parameters: previewParams,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const kob = albumById('kob');
const late = playlistById('late');
const blueInGreen = trackById('t3');

/** 1. Now Playing: the full view with the queue beside the cover (desktop); the full screen (phone). */
export const NowPlayingDesktopView: Story = {
  name: 'Now Playing Desktop',
  render: () => (
    <Shell active={null} playlistsLink title="Now playing" dock={<DesktopBar queueOpen />}>
      <NowPlayingDesktop />
    </Shell>
  ),
};
export const NowPlayingPhoneView: Story = {
  name: 'Now Playing Phone',
  render: () => (
    <Shell active="albums" playlistsLink title="Chet" phoneDetail overlay={<NowPlayingPhone variant="B" />}>
      <AlbumPage album={albumById('chet')} />
    </Shell>
  ),
};

/** 2. The queue: History in the Now Playing view (desktop); the Queue half of the phone's Now Playing. */
export const QueueDesktop: Story = {
  render: () => (
    <Shell active={null} playlistsLink title="Now playing" dock={<DesktopBar queueOpen />}>
      <NowPlayingDesktop tab="history" />
    </Shell>
  ),
};
export const QueuePhone: Story = {
  render: () => (
    <Shell active="albums" playlistsLink title="Chet" phoneDetail overlay={<NowPlayingPhone variant="B" segment="queue" />}>
      <AlbumPage album={albumById('chet')} />
    </Shell>
  ),
};

/** 3. A track's ⋮: Add to playlist… opens the picker (no submenu). */
export const TrackMenuDesktop: Story = {
  render: () => (
    <Shell active="albums" playlistsLink title="Kind of Blue" dock={<DesktopBar />}>
      <AlbumPage album={kob} openTrack={blueInGreen.id} menu={<GlassList style={{ top: 48, right: 4 }} rows={trackMenuRows(false)} />} />
    </Shell>
  ),
};
export const TrackMenuPhone: Story = {
  render: () => (
    <Shell active="albums" playlistsLink title="Kind of Blue" phoneDetail dock={<MiniBarB />}>
      <AlbumPage album={kob} openTrack={blueInGreen.id} />
      <TrackDrawer track={blueInGreen} />
    </Shell>
  ),
};

/** 4. Add to playlist: a picker of covers (dialog on a desktop, drawer on a phone). */
export const AddToPlaylistDesktop: Story = {
  render: () => (
    <Shell active="albums" playlistsLink title="Kind of Blue" dock={<DesktopBar />} overlay={<PickerDialog track={blueInGreen} />}>
      <AlbumPage album={kob} />
    </Shell>
  ),
};
export const AddToPlaylistPhone: Story = {
  render: () => (
    <Shell active="albums" playlistsLink title="Kind of Blue" phoneDetail dock={<MiniBarB />}>
      <AlbumPage album={kob} />
      <PickerDrawer track={blueInGreen} />
    </Shell>
  ),
};

/** 5. Playlists: a main page, a grid of mosaic covers; Import and New in its header. */
export const PlaylistsDesktop: Story = {
  render: () => (
    <Shell active="playlists" playlistsLink title="Playlists" dock={<DesktopBar />}>
      <PlaylistsGrid importOpen />
    </Shell>
  ),
};
export const PlaylistsPhone: Story = {
  render: () => (
    <Shell active="playlists" playlistsLink title="Playlists" dock={<MiniBarB />}>
      <PlaylistsGrid />
    </Shell>
  ),
};

/** 6. A playlist: Edit mode reorders (handles) and removes (desktop); the plain list with Edit in the row (phone). */
export const PlaylistDesktop: Story = {
  render: () => (
    <Shell active="playlists" playlistsLink title={late.name} dock={<DesktopBar />}>
      <PlaylistPage p={late} lead="no" editing lifted={3} />
    </Shell>
  ),
};
export const PlaylistPhone: Story = {
  render: () => (
    <Shell active="playlists" playlistsLink title={late.name} phoneDetail dock={<MiniBarB />}>
      <PlaylistPage p={late} lead="cover" album={false} editKey />
    </Shell>
  ),
};
