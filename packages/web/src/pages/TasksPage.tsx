/**
 * Library care › Tasks (0032): gaps the owner confirmed and will fix
 * themselves ("Add to my tasks"). Nothing is ticked off by hand: the gap check
 * that runs after a scan finds the problem gone and crosses the task out.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { TASK_DONE_DAYS, TASK_NOTE_MAX, type GapTask } from '@liner/shared';
import { useCurrentLibrary } from '../hooks';
import { useGapTasks, useRecheckGaps, useSaveTaskNote } from '../hooks/useGaps';
import { ReopenGapButton } from '../components/GapChoices';
import { Button, EmptyState, Input, LinkButton } from '../components/ui';
import { doneLabel, taskText } from '../utils/gapTasks';
import styles from './TasksPage.module.css';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function NoteEditor({ task }: { task: GapTask }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.note ?? '');
  const save = useSaveTaskNote();
  if (!editing) {
    return (
      <span className={styles.note}>
        {task.note && <span className={styles.noteText}>{task.note}</span>}
        <Button variant="quiet" size="sm" onClick={() => { setDraft(task.note ?? ''); setEditing(true); }}>
          {task.note ? 'Edit note' : 'Add note'}
        </Button>
      </span>
    );
  }
  return (
    <form
      className={styles.noteForm}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ id: task.id, note: draft }, { onSuccess: () => setEditing(false) });
      }}
    >
      <Input
        dense
        autoFocus
        aria-label="Note on this task"
        placeholder="Where to look, who has the CD…"
        maxLength={TASK_NOTE_MAX}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
      />
      <Button type="submit" variant="secondary" size="sm" loading={save.isPending}>Save</Button>
      <Button variant="quiet" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
      {save.isError && <span className={styles.error} role="alert">Couldn’t save the note.</span>}
    </form>
  );
}

function TaskRow({ task }: { task: GapTask }) {
  const done = task.state === 'resolved';
  const text = taskText(task, task);
  const where = task.albumId ? (
    <Link to="/albums/$albumId" params={{ albumId: task.albumId } as never} search={{ issues: task.id } as never} className={styles.subject}>
      {task.title ?? 'Untitled'}{task.artist ? ` · ${task.artist}` : ''}
    </Link>
  ) : task.artistId ? (
    <Link to="/artists/$artistId" params={{ artistId: task.artistId } as never} className={styles.subject}>
      {task.artist ?? 'Artist'}
    </Link>
  ) : (
    <span className={styles.subjectPlain}>{task.title ?? 'Untitled'}</span>
  );
  return (
    <li className={`${styles.task} ${done ? styles.taskDone : ''}`}>
      <span className={`${styles.mark} ${done ? styles.markDone : ''}`} aria-hidden="true">
        {done && <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m4 8.5 2.5 2.5L12 5.5" /></svg>}
      </span>
      <div className={styles.body}>
        <p className={styles.text}>{done ? <s>{text}</s> : text}</p>
        <div className={styles.meta}>
          {where}
          <span>{done ? doneLabel(task) : `Added ${shortDate(task.acceptedAt)}`}</span>
          {!done && <NoteEditor task={task} />}
          {done && task.note && <span className={styles.noteText}>{task.note}</span>}
        </div>
      </div>
      {!done && (
        <div className={styles.actions}>
          <ReopenGapButton gapId={task.id} title="Take it off your task list; it goes back to Needs attention">Remove from tasks</ReopenGapButton>
        </div>
      )}
    </li>
  );
}

export function TasksPanel() {
  const { libraryId } = useCurrentLibrary();
  const { data, isLoading, isError, refetch } = useGapTasks(libraryId);
  const recheck = useRecheckGaps(libraryId);
  const todo = data?.todo ?? [];
  const done = data?.done ?? [];

  return (
    <div className={styles.container}>
      <div className={styles.intro}>
        <p>
          Things you said you’ll fix yourself, such as finding missing tracks and adding them to the album’s folder.
          You don’t tick them off: once the files are in place, the next scan checks again and crosses the task out.
        </p>
        <div className={styles.introActions}>
          <Button variant="secondary" size="sm" loading={recheck.isPending} onClick={() => recheck.mutate()} title="Run the gap check now instead of waiting for the next scan">
            Check again now
          </Button>
          {recheck.isSuccess && (
            <span className={styles.status} role="status">
              {recheck.data?.queued ? 'Check queued. Fixed tasks are crossed out when it finishes.' : 'A check is already waiting to run.'}
            </span>
          )}
          {recheck.isError && <span className={styles.error} role="alert">Couldn’t queue the check.</span>}
        </div>
      </div>

      {isLoading && <p className={styles.muted}>Loading tasks…</p>}
      {isError && (
        <p role="alert" className={styles.error}>
          Couldn’t load your tasks. <Button variant="quiet" size="sm" onClick={() => void refetch()}>Try again</Button>
        </p>
      )}

      {data && todo.length === 0 && (
        <EmptyState
          title="No tasks right now"
          text="When something under Needs attention is real and yours to fix, choose Add to my tasks. It stays here until a scan finds it fixed."
          action={<LinkButton variant="secondary" size="sm" to="/work" search={{ tab: 'attention' }}>Go to Resolve gaps</LinkButton>}
        />
      )}

      {todo.length > 0 && (
        <section aria-labelledby="tasks-todo">
          <h2 id="tasks-todo" className={styles.heading}>To do <span className={styles.count}>{todo.length}</span></h2>
          <ul className={styles.list}>{todo.map((t) => <TaskRow key={t.id} task={t} />)}</ul>
        </section>
      )}

      {done.length > 0 && (
        <section aria-labelledby="tasks-done">
          <h2 id="tasks-done" className={styles.heading}>Done <span className={styles.count}>{done.length}</span></h2>
          <p className={styles.muted}>Crossed out by a scan in the last {TASK_DONE_DAYS} days.</p>
          <ul className={styles.list}>{done.map((t) => <TaskRow key={t.id} task={t} />)}</ul>
        </section>
      )}
    </div>
  );
}
