import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { waitFor } from 'storybook/test';
import { PlayerBarView } from '../components/PlayerBar';
import { MiniPlayer, NowPlayingScreen, NowPlayingView } from '../components/player/NowPlaying';
import { BarGlow } from '../components/BarGlow';
import { Button, Chip } from '../components/ui';
import { applyAdaptive, coverSource } from '../adaptive/AdaptiveColour';
import { adaptiveTokens } from '../adaptive/scheme';
import { COVERS, COVER_KEYS, type CoverKey } from './adaptiveCovers';
import { HISTORY, QUEUE } from './queueFixtures';

/** The theme the toolbar set (data-theme on <html>). */
function useStoryDark(): boolean {
  return useSyncExternalStore((cb) => {
    const mo = new MutationObserver(cb);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, () => document.documentElement.getAttribute('data-theme') === 'dark');
}

/** What AdaptiveColour does in the app, for a fixture cover; data-ready once applied. */
function WithCover({ cover, children }: { cover: CoverKey; children: ReactNode }) {
  const dark = useStoryDark();
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void coverSource(COVERS[cover].src).then((argb) => {
      if (!live) return;
      applyAdaptive(argb === null ? null : adaptiveTokens(argb, dark), dark);
      setReady(`${cover}-${dark}`);
    });
    return () => { live = false; };
  }, [cover, dark]);
  useEffect(() => () => applyAdaptive(null, document.documentElement.getAttribute('data-theme') === 'dark'), []);
  return <div data-ready={ready === `${cover}-${dark}` ? '' : undefined} style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>{children}</div>;
}

interface Args { cover: CoverKey; glow: 'off' | 'calm' | 'peak'; playing: boolean; view?: 'bar' | 'now' | 'screen' | 'mini' }

const noop = () => undefined;

function Preview({ cover, glow, playing, view = 'bar' }: Args) {
  const c = COVERS[cover];
  // the queue fixtures, with this cover on the playing track
  const track = { ...QUEUE[0]!, title: c.title, artist: c.artist, album: c.album, albumArtist: c.artist, coverUrl: c.src, artists: [] };
  const queue = { tracks: [track, ...QUEUE.slice(1)], index: 0, context: { kind: 'album' as const, id: 'album-x', name: c.album }, onPlay: noop, onMove: noop, onRemove: noop, onClear: noop, history: HISTORY };
  const transport = { status: (playing ? 'playing' : 'paused') as 'playing' | 'paused', position: 83, duration: 321, canPrevious: true, canNext: true, onToggle: noop, onPrevious: noop, onNext: noop, onSeek: noop };
  // a loud peak held still (the strongest the glow gets: the contrast holds over it), or the calm breath
  const barGlow = glow === 'off' ? null : <BarGlow playing={playing} source="calm" level={glow === 'peak' && playing ? 1 : undefined} />;
  if (view === 'now') {
    return <WithCover cover={cover}><div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, height: 0, ['--player-bar-h' as string]: '0px' }}><NowPlayingView {...queue} track={track} onClose={noop} /></div></WithCover>;
  }
  if (view === 'screen') return <WithCover cover={cover}><NowPlayingScreen {...queue} {...transport} track={track} onClose={noop} /></WithCover>;
  if (view === 'mini') {
    return <WithCover cover={cover}><div style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}><MiniPlayer track={track} {...transport} onOpen={noop} onRetry={noop} glow={barGlow} /></div></WithCover>;
  }
  return (
    <WithCover cover={cover}>
      <div style={{ flex: 1, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: 24 }}>
        <Button>Play</Button>
        <Chip active>{c.album}</Chip>
        <a href="#" onClick={(e) => e.preventDefault()}>{c.artist}</a>
      </div>
      <PlayerBarView
        title={c.title} artist={c.artist} album={c.album} artists={null} albumId={null} coverUrl={c.src}
        status={playing ? 'playing' : 'paused'} message={null} position={83} duration={321} volume={0.8} canPrevious canNext
        onToggle={() => undefined} onPrevious={() => undefined} onNext={() => undefined} onSeek={() => undefined}
        onVolume={() => undefined} onRetry={() => undefined}
        glow={barGlow}
      />
    </WithCover>
  );
}

const meta = {
  title: 'Components/Adaptive colour',
  component: Preview,
  tags: ['shot-viewport'],
  args: { cover: 'moody', glow: 'off', playing: true },
  argTypes: {
    cover: { control: 'inline-radio', options: COVER_KEYS },
    glow: { control: 'inline-radio', options: ['off', 'calm', 'peak'] },
    view: { control: 'inline-radio', options: ['bar', 'now', 'screen', 'mini'] },
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, iframeHeight: 360 },
      description: {
        component: 'Settings › Appearance › Adaptive colours (on by default): while a cover plays, Material Color Utilities picks its source colour (Celebi quantizer, Score) and SchemeContent builds the scheme. The accent, the canvas and its wash follow primary and surface app-wide; the player bar and the mini bar on a phone are one quiet surface (TonalSpot secondary) a clear step from the canvas (1.45:1 in light), with its own inks found at 7:1 and 5:1. A cover with no usable colour keeps the brand teal. Now Playing shows the blurred cover over the tinted canvas as strongly as the darkest and lightest pixel of the cover let its text read. Changes cross-fade over 600 ms; a theme switch and reduced motion swap at once. Equalizer glow (off by default) is a row of soft columns along the bar\'s bottom edge, behind its content, fullest in the middle: the music\'s levels on desktop and Android (a loud peak reaches half the bar), a slow breath on iOS, settled to a low line while paused; its colour stands apart from the bar and the text over it keeps its contrast.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => { if (!canvasElement.querySelector('[data-ready]')) throw new Error('scheme not applied yet'); }, { timeout: 5000 });
  },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Moody: Story = { name: 'Dark, moody cover' };
export const Bright: Story = { name: 'Bright, saturated cover', args: { cover: 'bright' } };
export const Mono: Story = { name: 'Colourless cover (brand teal)', args: { cover: 'mono' } };
export const Pastel: Story = { name: 'Pastel cover', args: { cover: 'pastel' } };
export const RedBlack: Story = { name: 'Red and black cover', args: { cover: 'redblack' } };
export const Glow: Story = { name: 'Equalizer glow, at a peak', args: { cover: 'redblack', glow: 'peak' } };
export const GlowPaused: Story = { name: 'Equalizer glow, paused', args: { cover: 'redblack', glow: 'calm', playing: false } };
export const GlowPastel: Story = { name: 'Equalizer glow, pastel cover at a peak', args: { cover: 'pastel', glow: 'peak' } };
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { cover: 'bright', glow: 'peak' } };
export const NowPlayingDesktop: Story = { name: 'Now Playing, desktop', args: { cover: 'pastel', view: 'now' } };
export const NowPlayingPhone: Story = { name: 'Now Playing, phone', tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { cover: 'moody', view: 'screen' } };
export const MiniBar: Story = { name: 'Mini bar, phone', tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { cover: 'redblack', view: 'mini' } };
export const MiniBarGlow: Story = { name: 'Mini bar, phone, glow at a peak', tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { cover: 'moody', view: 'mini', glow: 'peak' } };
