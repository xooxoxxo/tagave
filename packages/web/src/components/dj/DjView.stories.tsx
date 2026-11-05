import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { PageShell } from '../ui';
import { DjHead, DjUnavailable, DjView } from './DjView';
import { FX_DEFAULTS, cloneFx } from '../../player/deckFx';
import type { DeckView } from '../../player/djDecks';

const peaks = (seed: number) => Array.from({ length: 900 }, (_, i) => {
  if (i < 15 || i > 870) return 0.02;
  const beat = (i % 15) < 2 ? 0.35 : 0;
  return Math.min(1, 0.45 + 0.25 * Math.sin(i / (40 + seed * 7)) + beat);
});

const deck = (o: Partial<DeckView>): DeckView => ({
  uid: 'q1', trackId: 't1', title: 'Grid One', artist: 'Metro Nome', album: 'Grid Works', coverUrl: null, durationSec: 214, bpm: 120, firstBeatSec: 1.5, bpmConfidence: 0.95,
  rate: 1, sync: false, playing: true, loading: false, cue: 1.5, peaks: peaks(1), fx: cloneFx(FX_DEFAULTS), ...o,
});

const handlers = () => ({ onToggle() {}, onCue() {}, onSync() {}, onPitch() {}, onSeek() {}, onFilter() {}, onBand() {}, onKill() {}, onEcho() {} });

const A = deck({ fx: { ...cloneFx(FX_DEFAULTS), filter: -0.35, eq: { low: 0, mid: 3, high: 0 } } });
const B = deck({
  uid: 'q2', trackId: 't2', title: 'Near Tempo', artist: 'Clock Ward', album: 'Near Tempo EP', durationSec: 248, bpm: 123, rate: 0.9756, sync: true, peaks: peaks(3),
  fx: { ...cloneFx(FX_DEFAULTS), kills: { low: true, mid: false, high: false }, echo: { timeSec: 0.375, feedback: 0.35, mix: 0.3 } },
});

function Screen({ x = 0.35, auto = false, a = A, b = B }: { x?: number; auto?: boolean; a?: DeckView; b?: DeckView }) {
  const [value, setValue] = useState(x);
  const [on, setOn] = useState(auto);
  return (
    <PageShell hero={<DjHead auto={on} onAuto={setOn} onClose={() => undefined} />}>
      <DjView state={{ x: value, heard: value > 0.5 ? 1 : 0, decks: [a, b] }} position={(i) => (i === 0 ? 81 : 12.4)} deck={handlers} onCrossfader={setValue} />
    </PageShell>
  );
}

const meta = {
  title: 'Pages/DJ',
  component: Screen,
  parameters: { layout: 'fullscreen', docs: { description: { component: 'The DJ view (the dj module\'s Advanced mode): two decks (cover, names, the tempo heard, the waveform with downbeats, Play, Cue, Sync, Pitch, Filter, EQ with kills, Echo), the crossfader, the queue. Auto mix Off/On in the header. Stacked on a phone.' } } },
} satisfies Meta<typeof Screen>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BothPlaying: Story = {};
export const AutoMixOn: Story = { args: { auto: true, x: 0.62 } };
export const OneDeckEmpty: Story = { args: { x: 0, b: deck({ uid: null, trackId: null, title: '', artist: '', playing: false, peaks: null, bpm: null }) } };
export const BeingMeasured: Story = { args: { b: deck({ uid: 'q3', title: 'Far Tempo', artist: 'Fast Hands', playing: false, peaks: [], bpm: null, firstBeatSec: null }) } };
export const NotOnThisDevice: Story = {
  render: () => <PageShell hero={<DjHead onClose={() => undefined} />}><DjUnavailable value="Not on this device" /></PageShell>,
};
