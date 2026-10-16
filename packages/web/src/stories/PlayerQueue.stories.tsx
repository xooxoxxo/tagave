import type { Meta, StoryObj } from '@storybook/react-vite';
import type { PlayerQueueTrack } from '@tagave/shared';
import { PlayerQueueView } from '../components/PlayerQueue';

const t = (n: number, title: string, extra: Partial<PlayerQueueTrack> = {}): PlayerQueueTrack => ({
  localTrackId: `t${n}`, discNo: 1, trackNo: n, title, artist: 'Miles Davis', album: 'Kind of Blue', albumArtist: 'Miles Davis',
  durationMs: [562, 566, 337, 694, 588][n - 1]! * 1000, container: 'flac', codec: 'flac', lossless: true, mime: 'audio/flac', available: true, reason: null, ...extra,
});

const meta = {
  title: 'Components/Player queue',
  component: PlayerQueueView,
  // No screenshot baselines yet (DESIGN.md: render them on the CI runner, then drop `no-shot`).
  tags: ['no-shot'],
  args: {
    album: 'Kind of Blue',
    tracks: [t(1, 'So What'), t(2, 'Freddie Freeloader'), t(3, 'Blue in Green'), t(4, 'All Blues'), t(5, 'Flamenco Sketches')],
    index: 1,
    onPlay: () => undefined,
    onMove: () => undefined,
    onRemove: () => undefined,
    onClose: () => undefined,
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, iframeHeight: 560 },
      description: {
        component: 'The play queue, opened with the queue key in the player bar. The album’s tracks in play order: played ones quiet, the playing one marked with a still dot and "Now playing", the ones to come movable up and down and removable. A row plays its track. The header says where the music plays: this device (tagave never hands playback to another one). Escape or a press outside closes it.',
      },
    },
  },
  decorators: [(Story) => <div style={{ position: 'relative', height: 540, marginTop: 8 }}><div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 0 }}><Story /></div></div>],
} satisfies Meta<typeof PlayerQueueView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playing: Story = {};
export const LastTrack: Story = { name: 'Nothing after this', args: { index: 4 } };
export const NotOnThePlayer: Story = {
  name: 'Tracks not on the player',
  args: { tracks: [t(1, 'So What'), t(2, 'Freddie Freeloader', { available: false, reason: 'not_scanned' }), t(3, 'Blue in Green'), t(4, 'All Blues', { available: false, reason: 'no_file' }), t(5, 'Flamenco Sketches')], index: 0 },
};
