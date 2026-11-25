import type { Meta, StoryObj } from '@storybook/react-vite';
import { RunningNow, UpdateChecksView } from '../pages/SettingsUpdatesPage';
import { RepairRunView } from '../components/RepairRun';
import { APP_BUILD, FEED, WORKER_OLD, WORKER_SAME } from './updatesFixtures';
import { REPAIR_WAITING_NOW, nowAt, repairCrashLoopRun, repairDiskFullRun, repairWaitingRun, repairedRun } from './updateFixtures';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const noop = () => undefined;

const meta = {
  title: 'Settings/Updates',
  component: RunningNow,
  // The older stories have no baseline yet; the settings layout's stories opt in with `!no-shot`.
  tags: ['no-shot'],
  args: { app: APP_BUILD, workers: [WORKER_SAME, WORKER_OLD], updating: false, now: NOW },
  parameters: { docs: { description: { component: 'Running now: the app and every worker with its build. A worker on another build reads Updating while an update runs and for two minutes after it ends, Older build (the warning) otherwise. Update checks: Off and On saves when changed, the feed URL with its own Save. Repair: the run as the whole pane, the headline as its title, what was done behind the ?.' } } },
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
export const UpdateChecks: Story = { name: 'Update checks', tags: ['viewport-1440', '!no-shot'], render: () => checks({ enabledStatus: { state: 'saved' } }) };
/** A feed URL typed: its Save waits no more; the last save failed. */
export const UpdateChecksFeedChanged: Story = { name: 'Update checks, feed changed', tags: ['viewport-1440', '!no-shot'], render: () => checks({ url: 'https://api.github.com/repos/robin/tagave/releases', urlStatus: { state: 'failed', detail: 'Use a GitHub releases API URL' } }) };
/** The server sets the feed: a value, no switch. */
export const UpdateChecksLocked: Story = { name: 'Update checks, set on the server', tags: ['viewport-1440', '!no-shot'], render: () => checks({ feed: { ...FEED, lockedByServer: true } }) };
export const PhoneUpdateChecks: Story = { name: 'Phone, update checks', tags: ['phone', '!no-shot'], globals: { viewport: { value: 'phone' } }, render: () => checks({ url: 'https://api.github.com/repos/robin/tagave/releases' }) };

/*
 * Repair: the run takes the pane like an update run, the updater's headline
 * as the title, what was done behind "?". The lamp holds still (glyphTime).
 */
const repair = (run: Parameters<typeof RepairRunView>[0]['run'], now: number) => <RepairRunView run={run} now={now} glyphTime={120} onDismiss={noop} />;

/** A stuck file worker, stopped and started again: every part runs. */
export const RepairRepaired: Story = { name: 'Repair, repaired', tags: ['!no-shot'], render: () => repair(repairedRun(), nowAt(45)) };
/** The music share does not answer: nothing spins, the updater checks again on its own. */
export const RepairWaiting: Story = { name: 'Repair, waiting for the share', tags: ['!no-shot'], render: () => repair(repairWaitingRun(), REPAIR_WAITING_NOW) };
/** Only the owner can free space: the title says what to do, the "?" links Storage. */
export const RepairNeedsYouDiskFull: Story = { name: 'Repair, disk full', tags: ['!no-shot'], render: () => repair(repairDiskFullRun(), nowAt(45)) };
/** The file worker keeps stopping after one restart (needs you): its last error and Copy details are behind "?". */
export const RepairCrashLoop: Story = { name: 'Repair, crash loop', tags: ['!no-shot'], render: () => repair(repairCrashLoopRun(), nowAt(45)) };
export const PhoneRepairWaiting: Story = { name: 'Phone, repair waiting', tags: ['phone', 'shot-full', '!no-shot'], globals: { viewport: { value: 'phone' } }, render: () => repair(repairWaitingRun(), REPAIR_WAITING_NOW) };
