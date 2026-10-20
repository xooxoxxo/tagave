import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { RunView } from '../components/InAppUpdate';
import { RECOVERING, SIMULATED_END, didNotStartRun, nowAt, rolledBackRun, simulatedRun, stalledRun, updateRun } from './updateFixtures';

/** The lamp's clock for the still frames (s): shots repeat. */
const STILL = 120;

const meta = {
  title: 'Settings/Updates',
  component: RunView,
  args: { run: simulatedRun(60), now: nowAt(60), glyphTime: STILL, disconnected: false, reloading: false, restart: null, onDismiss: () => undefined },
  parameters: {
    docs: {
      description: {
        component:
          'Settings › Updates while an update runs: the whole page turns into the run. The glyph (dotted contours around slow lava-lamp blobs, seeded by the target version, growing with the run) spans the pane; under it the title and the time, only the steps that have started, the running one with what it does now (or why it is stuck), and each new step rolling in as a line when it starts. A success settles the glyph and clears itself; a failure tints it and stays until Done. `glyphTime` holds the glyph still (stories); without it the lamp moves while the run runs, unless reduced motion is asked for.',
      },
    },
  },
} satisfies Meta<typeof RunView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Restart, while the new app backs the database up before it migrates. */
export const Running: Story = {};
/** The first step, downloading: nothing after it shows yet. */
export const Downloading: Story = { args: { run: simulatedRun(18), now: nowAt(18) } };
export const Stalled: Story = { args: { run: stalledRun(), now: nowAt(240) } };
export const Recovering: Story = { args: { run: updateRun('waiting for the app: database recovering', RECOVERING), now: nowAt(300) } };
export const Succeeded: Story = { args: { run: simulatedRun(SIMULATED_END), now: nowAt(SIMULATED_END + 5) } };
export const RolledBack: Story = { args: { run: rolledBackRun(), now: nowAt(400) } };
export const DidNotStart: Story = { args: { run: didNotStartRun(), now: nowAt(6) } };
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { run: stalledRun(), now: nowAt(240) } };
/** On a phone the end states take a short title: the long one wrapped to three lines. */
export const PhoneRolledBack: Story = { tags: ['phone', 'shot-full'], globals: { viewport: { value: 'phone' } }, args: { run: rolledBackRun(), now: nowAt(400) } };

/** A whole run played back: `t` holds it at a second (and the lamp still); without `t` it plays, the lamp moving (no screenshot). */
function Playback({ t, speed = 1 }: { t?: number; speed?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (t !== undefined) return;
    const timer = setInterval(() => setTick((n) => (n >= SIMULATED_END + 6 ? 0 : n + 1)), 1000 / speed);
    return () => clearInterval(timer);
  }, [t, speed]);
  const s = t ?? tick;
  return <RunView run={simulatedRun(s)} now={nowAt(s)} {...(t === undefined ? {} : { glyphTime: STILL })} reloading={false} restart={null} onDismiss={() => undefined} />;
}

export const Timeline: StoryObj<{ t?: number; speed?: number }> = {
  tags: ['no-shot'],
  render: (args) => <Playback {...(args.t === undefined ? {} : { t: args.t })} speed={args.speed ?? 4} />,
  argTypes: { t: { control: { type: 'number', min: 0, max: SIMULATED_END + 6 } }, speed: { control: { type: 'number', min: 1, max: 16 } } },
};

/** The lamp at a moment of its clock, the run held at restart: frames for a look at the motion. */
export const Lamp: StoryObj<{ glyphTime: number }> = {
  tags: ['no-shot'],
  args: { glyphTime: 0 },
  render: ({ glyphTime }) => <RunView run={simulatedRun(60)} now={nowAt(60)} glyphTime={glyphTime} reloading={false} restart={null} onDismiss={() => undefined} />,
};

/** The lamp moving, the run held at restart (no screenshot: it moves). */
export const LampMoving: StoryObj = {
  tags: ['no-shot'],
  render: () => <RunView run={simulatedRun(60)} now={nowAt(60)} reloading={false} restart={null} onDismiss={() => undefined} />,
};
