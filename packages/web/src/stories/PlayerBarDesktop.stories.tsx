/**
 * The player bar in the app's desktop frame: always there, the sidebar's
 * account row beside it at its height. Before anything was played the keys,
 * the seek bar and the queue key are there but disabled and the track slot
 * is empty; once something was played the bar keeps the last track, paused.
 * 1440 and 1000 wide (at 1000 the volume steps aside, as it always has).
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PlayerBarView } from '../components/PlayerBar';
import { BarGlow } from '../components/BarGlow';
import { LikeKeyView } from '../components/LikeKey';
import { CoverArt, PageShell } from '../components/ui';
import { COVERS, COVER_KEYS } from './adaptiveCovers';
import { DesktopFrame } from './DesktopFrame';
import { CastKeyView } from '../components/player/CastKey';
import { DeviceStripView, DevicesKeyView } from '../components/player/DevicesKey';
import { BEAT_LEVELS, demoBeat } from './glowFixtures';
import s from './DesktopFrame.module.css';

type BarState = 'empty' | 'paused' | 'playing';
type CastShown = 'none' | 'available' | 'casting';
type Glow = 'off' | 'beat' | 'still' | 'live';
/** play in one place: another device plays (remote), or playback was handed here and waits for a tap */
type DeviceShown = 'none' | 'remote' | 'tap';
interface Args { state: BarState; compartmentOpen?: boolean; glow?: Glow; cast?: CastShown; device?: DeviceShown }

const noop = () => undefined;
const TRACK = COVERS.moody;
const DEMO = demoBeat();

function Albums() {
  return (
    <PageShell title="Albums">
      <div className={s.grid}>
        {[...COVER_KEYS, ...COVER_KEYS].map((k, i) => (
          <div key={i} className={s.album}>
            <CoverArt src={COVERS[k].src} title={COVERS[k].album} loading="eager" />
            <a href="#" onClick={(e) => e.preventDefault()}>{COVERS[k].album}</a>
            <span>{COVERS[k].artist}</span>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

function Bar({ state, glow = 'off', cast = 'none', device = 'none' }: { state: BarState; glow?: Glow; cast?: CastShown; device?: DeviceShown }) {
  const empty = state === 'empty';
  const casting = cast === 'casting';
  return (
    <PlayerBarView
      title={empty ? '' : TRACK.title} artist={empty ? '' : TRACK.artist} album={empty ? '' : TRACK.album} coverUrl={empty ? null : TRACK.src}
      status={empty ? 'idle' : state} position={empty ? 0 : state === 'paused' ? 96 : 141} duration={empty ? null : 321} volume={0.8}
      canPrevious={!empty} canNext={!empty} empty={empty}
      onToggle={noop} onPrevious={noop} onNext={noop} onSeek={noop} onVolume={noop} onRetry={noop} onQueue={noop}
      glow={glow === 'off' ? null : <BarGlow playing={state === 'playing'} anchor="right" source={glow === 'live' ? DEMO : 'still'} levels={glow === 'beat' ? BEAT_LEVELS : undefined} />}
      cast={device !== 'none' ? (
        <DevicesKeyView lit={device === 'remote'} onChoose={noop} devices={[{ id: 'mac', name: 'Chrome on Mac', here: true, playing: device === 'tap' }, { id: 'phone', name: 'Safari on iPhone', here: false, playing: device === 'remote' }]} />
      ) : cast === 'none' ? null : <CastKeyView kind="cast" available state={casting ? 'on' : 'off'} device={casting ? 'Living Room' : null} reach="ok" host={null} onChoose={noop} />}
      castLine={casting ? 'Casting to Living Room' : null}
      like={empty ? null : <LikeKeyView liked={state === 'playing'} size="sm" onToggle={noop} />}
    />
  );
}

function InTheApp({ state, compartmentOpen = false, glow = 'off', cast = 'none', device = 'none' }: Args) {
  const dock = (
    <>
      {device !== 'none' && <DeviceStripView playingOn={device === 'remote' ? 'Safari on iPhone' : null} needsTap={device === 'tap'} onTap={noop} />}
      <Bar state={state} glow={glow} cast={cast} device={device} />
    </>
  );
  return (
    <DesktopFrame empty={state === 'empty'} compartmentOpen={compartmentOpen} dock={dock}>
      <Albums />
    </DesktopFrame>
  );
}

const meta = {
  title: 'Components/Player bar/Desktop',
  component: InTheApp,
  tags: ['!autodocs'],
  args: { state: 'empty', compartmentOpen: false },
  argTypes: { state: { control: 'inline-radio', options: ['empty', 'paused', 'playing'] }, glow: { control: 'inline-radio', options: ['off', 'beat', 'still', 'live'] } },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof InTheApp>;
export default meta;
type Story = StoryObj<typeof meta>;

const wide = ['viewport-1440'];
const narrow = ['viewport-1000'];

export const Empty: Story = { tags: wide };
export const Paused: Story = { tags: wide, args: { state: 'paused' } };
export const Playing: Story = { tags: wide, args: { state: 'playing' } };
export const CompartmentOpen: Story = { tags: wide, args: { state: 'paused', compartmentOpen: true } };
/** Equalizer glow on, held mid-beat (from the bar's right side, falling off to the left), and paused (off). */
export const GlowPeak: Story = { name: 'Equalizer glow, mid-beat', tags: wide, args: { state: 'playing', glow: 'beat' } };
export const GlowPaused: Story = { name: 'Equalizer glow, paused', tags: wide, args: { state: 'paused', glow: 'beat' } };
/** Still: reduced motion, and where the music cannot be read (iOS). */
export const GlowStill: Story = { name: 'Equalizer glow, still', tags: wide, args: { state: 'playing', glow: 'still' } };
/** A demo beat, live: for looking at the motion (no screenshot, it moves). */
export const GlowLive: Story = { name: 'Equalizer glow, live demo beat', tags: ['viewport-1440', 'no-shot'], args: { state: 'playing', glow: 'live' } };
export const Empty1000: Story = { name: 'Empty, 1000', tags: narrow };
export const Paused1000: Story = { name: 'Paused, 1000', tags: narrow, args: { state: 'paused' } };
export const Playing1000: Story = { name: 'Playing, 1000', tags: narrow, args: { state: 'playing' } };
export const CompartmentOpen1000: Story = { name: 'Compartment open, 1000', tags: narrow, args: { state: 'paused', compartmentOpen: true } };
/** A cast device is there: the cast key beside the queue key. */
export const CastAvailable: Story = { name: 'Cast, device there', tags: wide, args: { state: 'playing', cast: 'available' } };
/** Casting: the key in the player's accent, the device beside it. */
export const Casting: Story = { name: 'Cast, casting', tags: wide, args: { state: 'playing', cast: 'casting' } };
export const CastingNarrow: Story = { name: 'Cast, casting, 1000', tags: narrow, args: { state: 'playing', cast: 'casting' } };
/** Another of the person's devices plays: the strip says where, the device key is lit, the keys control it. */
export const PlayingElsewhere: Story = { name: 'Playing on another device', tags: wide, args: { state: 'playing', device: 'remote' } };
export const PlayingElsewhereNarrow: Story = { name: 'Playing on another device, 1000', tags: narrow, args: { state: 'playing', device: 'remote' } };
/** Playback was handed here and the browser waits for a tap. */
export const TapToPlay: Story = { name: 'Tap to play here', tags: wide, args: { state: 'paused', device: 'tap' } };
