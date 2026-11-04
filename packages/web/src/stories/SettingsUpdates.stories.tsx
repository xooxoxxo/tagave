import type { Meta, StoryObj } from '@storybook/react-vite';
import { RunningNow } from '../pages/SettingsUpdatesPage';
import { APP_BUILD, WORKER_OLD, WORKER_SAME } from './updatesFixtures';

const NOW = Date.parse('2026-11-04T12:00:00Z');

const meta = {
  title: 'Settings/Updates',
  component: RunningNow,
  // No screenshot baseline yet: render one on the CI runner (DESIGN.md) and drop `no-shot`.
  tags: ['no-shot'],
  args: { app: APP_BUILD, workers: [WORKER_SAME, WORKER_OLD], updating: false, now: NOW },
  parameters: { docs: { description: { component: 'Running now: the app and every worker with its build. A worker on another build reads Updating while an update runs and for two minutes after it ends, Older build (the warning) otherwise.' } } },
} satisfies Meta<typeof RunningNow>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Right after an update: the worker has not restarted onto the new build yet. */
export const RunningNowUpdating: Story = { args: { updating: true } };
/** Nothing is updating and a worker still runs the build before. */
export const RunningNowOlderBuild: Story = {};
