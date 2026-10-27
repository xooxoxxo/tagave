/**
 * Design round rr55, a persistent player bar on a desktop: two directions,
 * branch-local previews (nothing in the app imports this folder). Today the
 * bar shows only once something was played, and the account row at the
 * sidebar's foot then stands alone. Here the bar is always there, as in
 * Spotify, Qobuz and Tidal; before anything was played its keys and seek bar
 * are there but disabled, and the track slot is empty.
 *
 * A: today's bar, one row, kept as it is (minus close).
 * B: the Spotify / Qobuz / Tidal arrangement: track left, the keys over the
 *    seek bar in the middle of the pane, queue and volume right.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { CoverArt, PageShell } from '../../../components/ui';
import { COVERS, COVER_KEYS } from '../../adaptiveCovers';
import { Shell } from './Shell';
import { BarA, BarB, type BarState } from './Bars';
import s from './bars.module.css';

interface Args { dir: 'A' | 'B'; state: BarState; compartmentOpen?: boolean }

function Albums() {
  return (
    <PageShell title="Albums">
      <div className={s.grid}>
        {[...COVER_KEYS, ...COVER_KEYS].map((k, i) => (
          <div key={i} className={s.album}>
            <CoverArt src={COVERS[k].src} title={COVERS[k].album} loading="eager" />
            <span>{COVERS[k].album}</span>
            <span>{COVERS[k].artist}</span>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

function Preview({ dir, state, compartmentOpen = false }: Args) {
  return (
    <Shell compartmentOpen={compartmentOpen} dock={dir === 'A' ? <BarA state={state} /> : <BarB state={state} />}>
      <Albums />
    </Shell>
  );
}

const meta = {
  title: 'Previews/Persistent bar (rr55)',
  component: Preview,
  // a design round: no baselines (the PNGs are taken at 1440 and 1000 by hand)
  tags: ['no-shot', '!autodocs'],
  args: { dir: 'A', state: 'idle', compartmentOpen: false },
  argTypes: {
    dir: { control: 'inline-radio', options: ['A', 'B'] },
    state: { control: 'inline-radio', options: ['idle', 'paused', 'playing'] },
  },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ANothingPlayed: Story = { name: 'A · Nothing played yet' };
export const APaused: Story = { name: 'A · Paused, last played', args: { state: 'paused' } };
export const APlaying: Story = { name: 'A · Playing', args: { state: 'playing' } };
export const ACompartment: Story = { name: 'A · Account compartment open', args: { state: 'paused', compartmentOpen: true } };
export const BNothingPlayed: Story = { name: 'B · Nothing played yet', args: { dir: 'B' } };
export const BPaused: Story = { name: 'B · Paused, last played', args: { dir: 'B', state: 'paused' } };
export const BPlaying: Story = { name: 'B · Playing', args: { dir: 'B', state: 'playing' } };
export const BCompartment: Story = { name: 'B · Account compartment open', args: { dir: 'B', state: 'paused', compartmentOpen: true } };
