/**
 * Design round rr50, direction A (Spotify / Apple Music): the queue in a
 * right-hand panel on a desktop and a drawer on a phone; playlists in the
 * sidebar under a "Playlists" section; a floating mini bar on a phone that
 * opens a full Now Playing screen. Previews only: nothing here is wired.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Shell } from './Shell';
import { AlbumPage, GlassList, MiniBarA, NowPlayingPhone as NowPlayingScreen, PlaylistListDrawer, PlaylistPage, QueueDrawer, SidePanel, SidebarPlaylists, TrackDrawer, playlistSubRows, trackMenuRows } from './parts';
import { albumById, playlistById, trackById } from './fixtures';
import { DesktopBar, previewParams } from './stage';

const meta = {
  title: 'Previews/Queue and playlists/A Panel and sidebar',
  tags: ['no-shot', '!autodocs'],
  parameters: previewParams,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const chet = albumById('chet');
const kob = albumById('kob');
const late = playlistById('late');
const blueInGreen = trackById('t3');

/** 1. The queue: a panel beside the page (desktop); Now Playing with the queue drawer (phone). */
export const QueueDesktop: Story = {
  render: () => (
    <Shell active="albums" title="Chet" sidebarSection={<SidebarPlaylists />} panel={<SidePanel mode="queue" />} dock={<DesktopBar queueOpen />}>
      <AlbumPage album={chet} />
    </Shell>
  ),
};
export const QueuePhone: Story = {
  render: () => (
    <Shell active="albums" title="Chet" phoneDetail overlay={<NowPlayingScreen variant="A" />}>
      <AlbumPage album={chet} />
      <QueueDrawer />
    </Shell>
  ),
};

/** 2. A track's ⋮: Play next, Add to queue, Add to playlist (a submenu on a desktop). */
export const TrackMenuDesktop: Story = {
  render: () => (
    <Shell active="albums" title="Kind of Blue" sidebarSection={<SidebarPlaylists />} dock={<DesktopBar />}>
      <AlbumPage
        album={kob}
        openTrack={blueInGreen.id}
        menu={<>
          <GlassList style={{ top: 48, right: 4 }} rows={trackMenuRows(true)} />
          <GlassList style={{ top: 140, right: 252 }} rows={playlistSubRows()} wide />
        </>}
      />
    </Shell>
  ),
};
export const TrackMenuPhone: Story = {
  render: () => (
    <Shell active="albums" title="Kind of Blue" phoneDetail dock={<MiniBarA />}>
      <AlbumPage album={kob} openTrack={blueInGreen.id} />
      <TrackDrawer track={blueInGreen} />
    </Shell>
  ),
};

/** 3. Saving: the queue saved as a playlist (desktop); Add to playlist as the drawer's second step (phone). */
export const SaveDesktop: Story = {
  render: () => (
    <Shell active="albums" title="Chet" sidebarSection={<SidebarPlaylists />} panel={<SidePanel mode="queue" naming />} dock={<DesktopBar queueOpen />}>
      <AlbumPage album={chet} />
    </Shell>
  ),
};
export const AddToPlaylistPhone: Story = {
  render: () => (
    <Shell active="albums" title="Kind of Blue" phoneDetail dock={<MiniBarA />}>
      <AlbumPage album={kob} />
      <PlaylistListDrawer track={blueInGreen} />
    </Shell>
  ),
};

/** 4. A playlist: drag handles always there (desktop), the ⋮ with Rename, Export, Delete. */
export const PlaylistDesktop: Story = {
  render: () => (
    <Shell active={null} title={late.name} sidebarSection={<SidebarPlaylists activeId="late" />} dock={<DesktopBar />}>
      <PlaylistPage p={late} lead="grip" menuOpen lifted={3} />
    </Shell>
  ),
};
export const PlaylistPhone: Story = {
  render: () => (
    <Shell active={null} title={late.name} phoneDetail dock={<MiniBarA />}>
      <PlaylistPage p={late} lead="cover" album={false} />
    </Shell>
  ),
};

/** 5. Now Playing: the panel's Now playing view (desktop); the full screen from the mini bar (phone). */
export const NowPlayingDesktop: Story = {
  render: () => (
    <Shell active="albums" title="Chet" sidebarSection={<SidebarPlaylists activeId="late" />} panel={<SidePanel mode="now" />} dock={<DesktopBar />}>
      <PlaylistPage p={late} lead="grip" />
    </Shell>
  ),
};
export const NowPlayingPhone: Story = {
  render: () => (
    <Shell active="albums" title="Chet" phoneDetail overlay={<NowPlayingScreen variant="A" />}>
      <AlbumPage album={chet} />
    </Shell>
  ),
};

/** 6. Where playlists live: the sidebar section and its + (New playlist, Import); on a phone, the menu sheet. */
export const LibraryDesktop: Story = {
  render: () => (
    <Shell active="albums" title="Waltz for Debby" sidebarSection={<SidebarPlaylists menuOpen />} dock={<DesktopBar />}>
      <AlbumPage album={albumById('debby')} />
    </Shell>
  ),
};
export const LibraryPhone: Story = {
  render: () => (
    <Shell active="albums" title="Albums" menuOpen sidebarSection={<SidebarPlaylists />} dock={<MiniBarA />}>
      <AlbumPage album={albumById('debby')} />
    </Shell>
  ),
};
