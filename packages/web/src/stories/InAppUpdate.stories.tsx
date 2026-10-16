import type { Meta, StoryObj } from '@storybook/react-vite';
import { RunView } from '../components/InAppUpdate';
import { CRASH_LOOP, RECOVERING, updateRun } from './updateFixtures';

const meta = {
  title: 'Settings/Updates',
  component: RunView,
  // No screenshot baseline yet: render one on the CI runner (DESIGN.md) and drop `no-shot`.
  tags: ['no-shot'],
  args: { run: updateRun('waiting for the app: updating the database (0046_cover_thumbs.sql)'), disconnected: false, reloading: false, restart: null, onDismiss: () => undefined },
  parameters: {
    docs: {
      description: {
        component: 'Settings › Updates while an update runs: the step list, what the running step does now, and, when a step has not moved for two minutes, the likely cause and what to do.',
      },
    },
  },
} satisfies Meta<typeof RunView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {};
export const Downloading: Story = {
  args: {
    run: {
      ...updateRun('downloading image 2 of 4 (340 MB of 1.1 GB)'),
      steps: updateRun('').steps.map((s, i) => (i === 0 ? { ...s, status: 'running' as const, finishedAt: null } : { ...s, status: 'pending' as const, startedAt: null, finishedAt: null })),
      progress: { step: 'preflight', message: 'downloading image 2 of 4 (340 MB of 1.1 GB)', at: '2026-10-16T10:00:40Z' },
    },
  },
};
export const Stalled: Story = { args: { run: updateRun('waiting for the app: it keeps restarting (last exit code 1)', CRASH_LOOP) } };
export const Recovering: Story = { args: { run: updateRun('waiting for the app: database recovering', RECOVERING) } };
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { run: updateRun('waiting for the app: it keeps restarting (last exit code 1)', CRASH_LOOP) } };
