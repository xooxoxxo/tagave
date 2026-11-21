import type { Meta, StoryObj } from '@storybook/react-vite';
import { RunningNow, UpdateChecksView } from '../pages/SettingsUpdatesPage';
import { APP_BUILD, FEED, WORKER_OLD, WORKER_SAME } from './updatesFixtures';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const noop = () => undefined;

const meta = {
  title: 'Settings/Updates',
  component: RunningNow,
  // No screenshot baseline yet: render one on the CI runner (DESIGN.md) and drop `no-shot`.
  tags: ['no-shot'],
  args: { app: APP_BUILD, workers: [WORKER_SAME, WORKER_OLD], updating: false, now: NOW },
  parameters: { docs: { description: { component: 'Running now: the app and every worker with its build. A worker on another build reads Updating while an update runs and for two minutes after it ends, Older build (the warning) otherwise. Update checks: Off and On saves when changed, the feed URL with its own Save.' } } },
} satisfies Meta<typeof RunningNow>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Right after an update: the worker has not restarted onto the new build yet. */
export const RunningNowUpdating: Story = { args: { updating: true } };
/** Nothing is updating and a worker still runs the build before. */
export const RunningNowOlderBuild: Story = {};

const checks = (over: Partial<Parameters<typeof UpdateChecksView>[0]> = {}) => (
  <div style={{ maxWidth: 850 }}>
    <UpdateChecksView feed={FEED} url="" onUrl={noop} onEnabled={noop} onSaveUrl={noop} onCheck={noop} {...over} />
  </div>
);

/** Update checks on, just turned on: ✓ Saved in the head. */
export const UpdateChecks: Story = { name: 'Update checks', tags: ['viewport-1440', 'no-shot'], render: () => checks({ enabledStatus: { state: 'saved' } }) };
/** A feed URL typed: its Save waits no more; the last save failed. */
export const UpdateChecksFeedChanged: Story = { name: 'Update checks, feed changed', tags: ['viewport-1440', 'no-shot'], render: () => checks({ url: 'https://api.github.com/repos/robin/tagave/releases', urlStatus: { state: 'failed', detail: 'Use a GitHub releases API URL' } }) };
/** The server sets the feed: a value, no switch. */
export const UpdateChecksLocked: Story = { name: 'Update checks, set on the server', tags: ['viewport-1440', 'no-shot'], render: () => checks({ feed: { ...FEED, lockedByServer: true } }) };
export const PhoneUpdateChecks: Story = { name: 'Phone, update checks', tags: ['phone', 'no-shot'], globals: { viewport: { value: 'phone' } }, render: () => checks({ url: 'https://api.github.com/repos/robin/tagave/releases' }) };
