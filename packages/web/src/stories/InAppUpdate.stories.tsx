import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { RunView } from '../components/InAppUpdate';
import { RECOVERING, SIMULATED_END, didNotStartRun, nowAt, rolledBackRun, simulatedRun, stalledRun, updateRun } from './updateFixtures';

const meta = {
  title: 'Settings/Updates',
  component: RunView,
  args: { run: simulatedRun(60), now: nowAt(60), disconnected: false, reloading: false, restart: null, onDismiss: () => undefined },
  parameters: {
    docs: {
      description: {
        component:
          'Settings › Updates while an update runs: only the steps that have started, the running one with what it does now (or why it is stuck), and each new step rolling in as a line when it starts.',
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
/** A whole run played back: `t` holds it at a second; without `t` it plays (no screenshot). */
function Playback({ t, speed = 1 }: { t?: number; speed?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (t !== undefined) return;
    const timer = setInterval(() => setTick((n) => (n >= SIMULATED_END + 6 ? 0 : n + 1)), 1000 / speed);
    return () => clearInterval(timer);
  }, [t, speed]);
  const s = t ?? tick;
  return <RunView run={simulatedRun(s)} now={nowAt(s)} disconnected={false} reloading={false} restart={null} onDismiss={() => undefined} />;
}

export const Timeline: StoryObj<{ t?: number; speed?: number }> = {
  tags: ['no-shot'],
  render: (args) => <Playback {...(args.t === undefined ? {} : { t: args.t })} speed={args.speed ?? 4} />,
  argTypes: { t: { control: { type: 'number', min: 0, max: SIMULATED_END + 6 } }, speed: { control: { type: 'number', min: 1, max: 16 } } },
};
