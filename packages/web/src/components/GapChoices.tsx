/**
 * The three choices every gap offers (0032), and the plain words for them.
 *
 * - Add to my tasks: it is real and I will fix it. It goes on Library care ›
 *   Tasks; the scan that sees it fixed crosses it out.
 * - Not a problem: it is real but fine by me. Hidden; can be shown again.
 * - This is wrong: the check made a mistake. Hidden, and the fix is offered.
 */
import type { ReactNode } from 'react';
import { useDecideGap } from '../hooks/useGaps';
import { Button } from './ui';
import styles from './GapChoices.module.css';

export const CHOICE_HELP = {
  task: 'It’s real and you’ll fix it yourself. It goes on your task list, and the next scan crosses it out once it’s fixed.',
  notAProblem: 'It’s real but fine by you, for example you only own part of this album. It stops showing; you can bring it back.',
  wrong: 'The check made a mistake, for example the wrong edition was matched. It’s hidden and you’re shown how to put it right.',
} as const;

/** The legend shown once above a list of gaps, so each choice is explained where it is offered. */
export function GapChoicesHelp({ className }: { className?: string }) {
  return (
    <dl className={[styles.help, className].filter(Boolean).join(' ')} aria-label="What the choices mean">
      <div><dt>Add to my tasks</dt><dd>{CHOICE_HELP.task}</dd></div>
      <div><dt>Not a problem</dt><dd>{CHOICE_HELP.notAProblem}</dd></div>
      <div><dt>This is wrong</dt><dd>{CHOICE_HELP.wrong}</dd></div>
    </dl>
  );
}

interface GapChoicesProps {
  gapId: string;
  /** what the row is about, for the buttons' accessible names ("Incomplete", "No cover art") */
  subject: string;
  /** a fix-it-now action for this row (Fetch art, Fix tags), shown first */
  fix?: ReactNode;
  /** called after a choice is saved (the album page refetches) */
  onDecided?: () => void;
  /** the album page's accordion rows: a compact segmented set, each choice with its one-line hint */
  compact?: boolean;
}

/** One line each, for the compact set inside an expanded row. */
export const CHOICE_HINT = {
  task: 'You’ll fix it; a scan ticks it off',
  notAProblem: 'Fine by you; stop showing it',
  wrong: 'The check erred; hide it, see the fix',
} as const;

export function GapChoices({ gapId, subject, fix, onDecided, compact }: GapChoicesProps) {
  const decide = useDecideGap();
  const pending = decide.isPending ? decide.variables?.choice : undefined;
  const choose = (choice: 'task' | 'not_a_problem' | 'wrong') =>
    decide.mutate({ id: gapId, choice } as Parameters<typeof decide.mutate>[0], { onSuccess: () => onDecided?.() });
  if (compact) {
    const options = [
      { choice: 'task' as const, label: 'Add to my tasks', hint: CHOICE_HINT.task, title: CHOICE_HELP.task },
      { choice: 'not_a_problem' as const, label: 'Not a problem', hint: CHOICE_HINT.notAProblem, title: CHOICE_HELP.notAProblem },
      { choice: 'wrong' as const, label: 'This is wrong', hint: CHOICE_HINT.wrong, title: CHOICE_HELP.wrong },
    ];
    return (
      <div className={styles.segmentWrap}>
        <div className={styles.segments} role="group" aria-label={`What to do about: ${subject}`}>
          {options.map((o) => (
            <button
              key={o.choice}
              type="button"
              className={styles.segment}
              title={o.title}
              disabled={decide.isPending}
              aria-busy={pending === o.choice || undefined}
              onClick={() => choose(o.choice)}
            >
              <span className={styles.segmentLabel}>{pending === o.choice ? 'Saving…' : o.label}</span>
              <span className={styles.segmentHint}>{o.hint}</span>
            </button>
          ))}
        </div>
        {decide.isError && <span className={styles.error} role="alert">Couldn’t save that. Try again.</span>}
      </div>
    );
  }
  return (
    <div className={styles.choices} role="group" aria-label={`What to do about: ${subject}`}>
      {fix}
      <Button variant="secondary" size="sm" loading={pending === 'task'} disabled={decide.isPending} onClick={() => choose('task')} title={CHOICE_HELP.task}>
        Add to my tasks
      </Button>
      <Button variant="quiet" size="sm" loading={pending === 'not_a_problem'} disabled={decide.isPending} onClick={() => choose('not_a_problem')} title={CHOICE_HELP.notAProblem}>
        Not a problem
      </Button>
      <Button variant="quiet" size="sm" loading={pending === 'wrong'} disabled={decide.isPending} onClick={() => choose('wrong')} title={CHOICE_HELP.wrong}>
        This is wrong
      </Button>
      {decide.isError && <span className={styles.error} role="alert">Couldn’t save that. Try again.</span>}
    </div>
  );
}

/** "Show again" on a hidden gap, "Remove from tasks" on a task: back to undecided. */
export function ReopenGapButton({ gapId, children, onDecided, title }: { gapId: string; children: ReactNode; onDecided?: () => void; title?: string }) {
  const decide = useDecideGap();
  return (
    <Button variant="quiet" size="sm" loading={decide.isPending} onClick={() => decide.mutate({ id: gapId, choice: 'reopen' }, { onSuccess: () => onDecided?.() })} title={title}>
      {children}
    </Button>
  );
}
