import type { Meta, StoryObj } from '@storybook/react-vite';
import { MiniPlayer, NowPlayingScreen, NowPlayingView } from '../components/player/NowPlaying';
import { HISTORY, QUEUE } from './queueFixtures';

const noop = () => undefined;
const queue = {
  tracks: QUEUE,
  index: 0,
  context: { kind: 'album' as const, id: 'album-chet', name: 'Chet' },
  onPlay: noop,
  onMove: noop,
  onRemove: noop,
  onClear: noop,
  history: HISTORY,
  onSave: async () => undefined,
};
const transport = { status: 'playing' as const, position: 141, duration: 413, canPrevious: true, canNext: true, onToggle: noop, onPrevious: noop, onNext: noop, onSeek: noop };

const meta = {
  title: 'Components/Now Playing',
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, iframeHeight: 640 },
      description: {
        component: 'Now Playing (direction B, Qobuz). On a desktop the queue key in the player bar opens a full view over the page: the cover, the title, artist and album as links, a few credits, and the queue beside them (Up next | History). Up next has the playing track, "Next in queue" (what was added with Play next or Add to queue; Clear takes those out) and "Next from" the album or playlist; a row\'s handle reorders it (drag, or Arrow up / down), its × takes it out, the row plays it. Save as playlist keeps the queue. On a phone the mini bar (play / pause, next, the progress as a hairline) opens a full screen with Playing | Queue. The queue is kept on the server, so it follows the person to another device; the device that played last plays, and another one pauses.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The desktop view sits over the page, on the bar: here the frame's foot stands in for the bar. */
const OverPage = ({ children }: { children: React.ReactNode }) => (
  <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, height: 0, ['--player-bar-h' as string]: '0px' }}>{children}</div>
);

export const DesktopUpNext: Story = {
  name: 'Desktop · Up next',
  tags: ['shot-viewport'],
  render: () => <OverPage><NowPlayingView {...queue} track={QUEUE[0]!} onClose={noop} /></OverPage>,
};

export const DesktopHistory: Story = {
  name: 'Desktop · History',
  tags: ['shot-viewport'],
  render: () => <OverPage><NowPlayingView {...queue} track={QUEUE[0]!} onClose={noop} initialTab="history" /></OverPage>,
};

export const PhonePlaying: Story = {
  name: 'Phone · Playing',
  tags: ['phone'],
  globals: { viewport: { value: 'phone' } },
  render: () => <NowPlayingScreen {...queue} {...transport} track={QUEUE[0]!} onClose={noop} />,
};

export const PhoneQueue: Story = {
  name: 'Phone · Queue',
  tags: ['phone'],
  globals: { viewport: { value: 'phone' } },
  render: () => <NowPlayingScreen {...queue} {...transport} track={QUEUE[0]!} onClose={noop} initialSegment="queue" />,
};

export const PhoneMiniBar: Story = {
  name: 'Phone · Mini bar',
  tags: ['phone'],
  globals: { viewport: { value: 'phone' } },
  render: () => (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}>
      <MiniPlayer track={QUEUE[0]!} status="playing" position={141} duration={413} canNext onOpen={noop} onToggle={noop} onNext={noop} onRetry={noop} />
    </div>
  ),
};

export const PhoneMiniBarLongNames: Story = {
  name: 'Phone · Mini bar, long names',
  tags: ['phone'],
  globals: { viewport: { value: 'phone' } },
  render: () => (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}>
      <MiniPlayer
        track={{ ...QUEUE[0]!, title: 'Concerto for Two Violins in D minor, BWV 1043: I. Vivace', artist: 'Academy of St Martin in the Fields, Sir Neville Marriner' }}
        status="paused" position={30} duration={413} canNext={false} onOpen={noop} onToggle={noop} onNext={noop} onRetry={noop}
      />
    </div>
  ),
};
