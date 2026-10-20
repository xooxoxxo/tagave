/**
 * PREVIEWS (rr41, phase 1): the two directions for the update's run, on the
 * real simulated run (updateFixtures) moved to 0.12.1 → 0.13.0. `frame`
 * picks the moment; the glyph is held still (fixed phase) so shots repeat.
 * A shell stub stands in for the app's frame around the pane.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { UpdateRun } from '@tagave/shared';
import { PlayerBarView } from '../components/PlayerBar';
import { TakeoverView, UpdateDownScreen, UpdateHeroCard, UpdateStrip } from '../components/update/UpdateViews';
import { runProgress } from '../components/update/glyphPaint';
import { SIMULATED_END, nowAt, rolledBackRun, simulatedRun } from './updateFixtures';
import { COVER_SRC } from './fixtures';
import styles from './UpdateExperience.stories.module.css';

type Frame = 'start' | 'downloading' | 'backup' | 'restart' | 'verify' | 'success' | 'failure';
const FRAMES: Frame[] = ['start', 'downloading', 'backup', 'restart', 'verify', 'success', 'failure'];
const AT: Record<Exclude<Frame, 'failure'>, number> = { start: 1, downloading: 18, backup: 41, restart: 60, verify: 84, success: SIMULATED_END };

/** The fixtures' 0.11.0 → 0.12.0 run as 0.12.1 → 0.13.0. */
const retarget = (run: UpdateRun): UpdateRun => JSON.parse(JSON.stringify(run).replaceAll('0.12.0', '0.13.0').replaceAll('0.11.0', '0.12.1')) as UpdateRun;

function frameRun(frame: Frame): { run: UpdateRun; now: number } {
  if (frame === 'failure') return { run: retarget(rolledBackRun()), now: nowAt(400) };
  const t = AT[frame];
  return { run: retarget(simulatedRun(t)), now: nowAt(frame === 'success' ? t + 1 : t) };
}

const PHASE = 1.2;
const NAV = ['Albums', 'Artists', 'Wantlist', 'Settings'];

/** The app's frame, stubbed: a sidebar on a desktop, a top bar on a phone. */
function Shell({ active, children, banner }: { active: string; children: React.ReactNode; banner?: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <nav className={styles.side} aria-label="Stub navigation">
        <span className={styles.brand}>tagave</span>
        {NAV.map((n) => <span key={n} className={n === active ? styles.navOn : styles.nav}>{n}</span>)}
      </nav>
      <div className={styles.main}>
        {banner}
        <div className={styles.topbar}><span className={styles.brand}>tagave</span><span className={styles.nav}>{active}</span></div>
        {children}
      </div>
    </div>
  );
}

/** What a listener looks at: an album grid (stub covers). */
function Library() {
  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Albums</h1>
      <div className={styles.grid}>
        {Array.from({ length: 12 }, (_, i) => <img key={i} src={COVER_SRC} alt="" className={styles.cover} style={{ filter: `hue-rotate(${i * 30}deg)` }} />)}
      </div>
    </div>
  );
}

const player = (
  <PlayerBarView title="So What" artist="Miles Davis" album="Kind of Blue" coverUrl={COVER_SRC} status="playing" message={null} position={83} duration={562}
    volume={0.8} canPrevious canNext onToggle={() => undefined} onPrevious={() => undefined} onNext={() => undefined} onSeek={() => undefined}
    onVolume={() => undefined} onRetry={() => undefined} onClose={() => undefined} />
);

function Preview({ direction, audience, frame }: { direction: 'A' | 'B'; audience: 'owner' | 'others'; frame: Frame }) {
  const { run, now } = frameRun(frame);
  const progress = runProgress(run, now);
  if (audience === 'others') {
    if (frame === 'restart') return <Shell active="Albums"><Library /><UpdateDownScreen target={run.target} progress={progress} phase={PHASE} player={player} /></Shell>;
    const strip = direction === 'A' && run.status === 'running' ? <UpdateStrip target={run.target} progress={progress} phase={PHASE} /> : undefined;
    return <Shell active="Albums" banner={strip}><Library /></Shell>;
  }
  if (direction === 'A') return <Shell active="Settings"><TakeoverView run={run} now={now} onDismiss={() => undefined} phase={PHASE} /></Shell>;
  return (
    <Shell active="Settings">
      <div className={styles.page}>
        <h1 className={styles.pageTitle}>Updates</h1>
        <UpdateHeroCard run={run} now={now} onDismiss={() => undefined} phase={PHASE} />
      </div>
    </Shell>
  );
}

const meta = {
  title: 'Previews/Update experience',
  component: Preview,
  tags: ['no-shot', '!autodocs'],
  args: { direction: 'A', audience: 'owner', frame: 'restart' },
  argTypes: { frame: { control: 'inline-radio', options: FRAMES }, direction: { control: 'inline-radio', options: ['A', 'B'] }, audience: { control: 'inline-radio', options: ['owner', 'others'] } },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TakeoverOwner: Story = { args: { direction: 'A', audience: 'owner' } };
export const TakeoverOthers: Story = { args: { direction: 'A', audience: 'others' } };
export const CardOwner: Story = { args: { direction: 'B', audience: 'owner' } };
export const CardOthers: Story = { args: { direction: 'B', audience: 'others' } };
