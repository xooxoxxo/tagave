/**
 * The banner at the top of Settings › Background activity. It must agree
 * with the rest of the page: the activity list only holds the larger tasks,
 * so the background queue and the albums still waiting for identification
 * count too. "All caught up" is said only when all three are empty.
 */
import type { JobsSummary } from '@liner/shared';

export interface SummaryMessage {
  tone: 'danger' | 'info' | 'success';
  lead: string;
  text: string;
}

const n = (v: number) => v.toLocaleString('en-US');
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

export function summaryMessage(opts: {
  summary: Pick<JobsSummary, 'running' | 'waiting' | 'needsAttention' | 'lastFinishedAt'> & { queue?: JobsSummary['queue'] | undefined };
  /** labels of the tasks listed as running */
  runningNames: string[];
  anyRetryable: boolean;
  /** albums identification has not checked yet (undefined while loading or while a run is under way) */
  pendingAlbums?: number | undefined;
  /** "3 minutes ago" for lastFinishedAt */
  relative: (iso: string) => string;
}): SummaryMessage {
  const { summary, runningNames, anyRetryable, pendingAlbums = 0, relative } = opts;
  const queue = summary.queue ?? { waiting: 0, active: 0 };

  if (summary.needsAttention > 0) {
    const many = summary.needsAttention !== 1;
    return {
      tone: 'danger',
      lead: `${plural(summary.needsAttention, 'task')} ${many ? 'need' : 'needs'} your attention.`,
      text: anyRetryable
        ? 'See what went wrong below; once the cause is fixed, press Retry where it is offered.'
        : `See what went wrong below. ${many ? 'They' : 'It'} cannot be restarted from this page.`,
    };
  }

  const running = Math.max(summary.running, queue.active);
  const waiting = Math.max(summary.waiting, queue.waiting);
  if (running > 0 || waiting > 0) {
    const names = runningNames.slice(0, 3).join(', ');
    const parts = [
      names ? `${names}${runningNames.length > 3 ? ' and more' : ''}.` : running > 0 ? `${plural(running, 'task')} running.` : '',
      waiting > 0 ? `${plural(waiting, 'task')} waiting to start.` : '',
    ].filter(Boolean);
    return { tone: 'info', lead: 'Working.', text: parts.join(' ') };
  }

  if (pendingAlbums > 0) {
    return {
      tone: 'info',
      lead: 'Albums are waiting.',
      text: `Nothing is running right now, but ${plural(pendingAlbums, 'album')} ${pendingAlbums === 1 ? 'has' : 'have'} not been checked yet. The next identification run picks them up, or press Check waiting albums now below.`,
    };
  }

  return {
    tone: 'success',
    lead: 'All caught up.',
    text: summary.lastFinishedAt ? `Nothing is running; the last task finished ${relative(summary.lastFinishedAt)}.` : 'Nothing is running.',
  };
}
