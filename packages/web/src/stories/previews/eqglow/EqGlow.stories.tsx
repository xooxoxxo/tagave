/**
 * Design round rr55, the equalizer glow at the bottom of the window: two
 * motion directions over the persistent bar (A), branch-local previews
 * (nothing in the app imports this folder). A synthetic spectrum drives
 * them (spectrum.ts), so they move without audio; `t` holds a still.
 * Under reduced motion both hold a calm, still glow.
 *
 * Hearth: narrow tongues on a canvas, flickering with their bands, blurred
 *   into one fire along the bar.
 * Horizon: seven wide CSS lobes swelling with their band groups, slower to
 *   fall: a neon horizon breathing with the music.
 */
import { useLayoutEffect, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PlayerBarView } from '../../../components/PlayerBar';
import { MiniPlayer } from '../../../components/player/NowPlaying';
import { CoverArt, PageShell } from '../../../components/ui';
import bar from '../../../components/PlayerBar.module.css';
import { COVERS, COVER_KEYS } from '../../adaptiveCovers';
import { QUEUE } from '../../queueFixtures';
import { DesktopFrame } from '../../DesktopFrame';
import { Hearth, Horizon } from './Glows';
import s from './glows.module.css';

interface Args { dir: 'hearth' | 'horizon'; phone?: boolean; t?: number }

const noop = () => undefined;
const TRACK = COVERS.moody;

function Albums({ phone = false }: { phone?: boolean }) {
  const grid = (
    <div className={s.grid}>
      {[...COVER_KEYS, ...COVER_KEYS].map((k, i) => (
        <div key={i} className={s.album}>
          <CoverArt src={COVERS[k].src} title={COVERS[k].album} loading="eager" />
          <a href="#" onClick={(e) => e.preventDefault()}>{COVERS[k].album}</a>
          <span>{COVERS[k].artist}</span>
        </div>
      ))}
    </div>
  );
  return phone ? grid : <PageShell title="Albums">{grid}</PageShell>;
}

function Glow({ dir, t }: { dir: Args['dir']; t?: number | undefined }) {
  return <div className={s.layer}>{dir === 'hearth' ? <Hearth time={t} /> : <Horizon time={t} />}</div>;
}

function Phone({ dir, t }: { dir: Args['dir']; t?: number | undefined }) {
  const dock = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const d = dock.current;
    const r = root.current;
    if (!d || !r) return;
    const write = () => r.style.setProperty('--player-bar-h', `${d.getBoundingClientRect().height}px`);
    write();
    const ro = new ResizeObserver(write);
    ro.observe(d);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={root} className={`${s.phone} ${s.area}`}>
      <Glow dir={dir} t={t} />
      <main className={s.phoneMain}><Albums phone /></main>
      <div ref={dock} className={bar.dock}>
        <MiniPlayer track={QUEUE[0]!} status="playing" message={null} position={141} duration={413} canNext onOpen={noop} onToggle={noop} onNext={noop} onRetry={noop} />
      </div>
    </div>
  );
}

function Preview({ dir, phone = false, t }: Args) {
  if (phone) return <Phone dir={dir} t={t} />;
  return (
    <DesktopFrame
      behind={<Glow dir={dir} t={t} />}
      dock={
        <PlayerBarView
          title={TRACK.title} artist={TRACK.artist} album={TRACK.album} coverUrl={TRACK.src} status="playing" position={141} duration={321} volume={0.8}
          canPrevious canNext onToggle={noop} onPrevious={noop} onNext={noop} onSeek={noop} onVolume={noop} onRetry={noop} onQueue={noop}
        />
      }
    >
      <Albums />
    </DesktopFrame>
  );
}

const meta = {
  title: 'Previews/Equalizer glow (rr55)',
  component: Preview,
  // a design round: no baselines (the videos and stills are taken by hand)
  tags: ['no-shot', '!autodocs'],
  args: { dir: 'hearth', phone: false },
  argTypes: { dir: { control: 'inline-radio', options: ['hearth', 'horizon'] }, t: { control: { type: 'number', min: 0, max: 60, step: 0.1 } } },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { globals: { viewport: { value: 'phone' } }, args: { phone: true } } as const;

export const Hearth1440: Story = { name: 'Hearth' };
export const HearthPhone: Story = { name: 'Hearth, phone', ...phone, args: { ...phone.args, dir: 'hearth' } };
export const HearthStill: Story = { name: 'Hearth, still', args: { t: 12.4 } };
export const Horizon1440: Story = { name: 'Horizon', args: { dir: 'horizon' } };
export const HorizonPhone: Story = { name: 'Horizon, phone', ...phone, args: { ...phone.args, dir: 'horizon' } };
export const HorizonStill: Story = { name: 'Horizon, still', args: { dir: 'horizon', t: 12.4 } };
