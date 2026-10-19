/**
 * The wantlist, with the suggestions linked apps make beside it (Music
 * Connections wantlist-suggestions). Accept tells the app that suggested it
 * and adds the album to the wantlist kept in tagave; Dismiss tells it too.
 * When the app refuses (403) or no longer has the suggestion (404), the
 * row says so and nothing changes.
 *
 * Everything shown came from another app: it is set as text, never HTML.
 * WantlistPanel is the view (stories); WantlistSection wires it and hides
 * itself when Music Connections is off and the wantlist is empty.
 */
import { useState } from 'react';
import type { WantlistDecision, WantlistEntryView, WantlistSuggestionView, WantlistView } from '@tagave/shared';
import { Button } from './ui';
import { useWantlist, useWantlistDecision } from '../hooks/useWantlist';
import { useCurrentLibrary } from '../hooks';
import { shortDate } from '../utils/time';
import styles from './WantlistSection.module.css';

export interface WantlistPanelProps {
  view: WantlistView;
  /** the suggestion whose decision is on its way */
  pending?: { id: string; decision: WantlistDecision } | null;
  /** per suggestion: why the last decision did not go through */
  errors?: Record<string, string>;
  onDecide: (s: WantlistSuggestionView, decision: WantlistDecision) => void;
}

function Entry({ e }: { e: WantlistEntryView }) {
  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <h4 className={styles.albumTitle}>{e.title ?? (e.discogsReleaseId ? `Discogs release ${e.discogsReleaseId}` : 'Untitled')}</h4>
        {e.artist && <span className={styles.artist}>{e.artist}</span>}
      </div>
      {e.dateAdded && <p className={styles.meta}>{shortDate(e.dateAdded, { time: false })}</p>}
    </li>
  );
}

export function WantlistPanel({ view, pending = null, errors = {}, onDecide }: WantlistPanelProps) {
  const open = view.suggestions.filter((s) => s.decision === null);
  return (
    <section className={styles.section} aria-labelledby="wantlist-title">
      <div className={styles.head}>
        <h2 id="wantlist-title" className={styles.title}>Wantlist</h2>
      </div>
      {view.wantlist.length > 0
        ? <ul className={styles.list} aria-label="Your wantlist">{view.wantlist.map((e) => <Entry key={e.id} e={e} />)}</ul>
        : <p className={styles.empty}>Nothing yet</p>}

      {view.available && (
        <>
          <h3 className={styles.subTitle}>Suggestions</h3>
          {open.length === 0 ? (
            <p className={styles.empty}>No suggestions</p>
          ) : (
            <ul className={styles.list} aria-label="Suggestions">
              {open.map((s) => {
                const busy = pending?.id === s.id;
                const error = errors[s.id];
                return (
                  <li key={s.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <h4 className={styles.albumTitle}>{s.title}</h4>
                      <span className={styles.artist}>{s.artist}</span>
                    </div>
                    <p className={styles.reason}>{s.reason}</p>
                    <p className={styles.meta}>From {s.service}{s.score !== null ? ` · score ${s.score.toFixed(1)} of 10` : ''}</p>
                    <div className={styles.actions}>
                      <Button size="sm" onClick={() => onDecide(s, 'accepted')} loading={busy && pending?.decision === 'accepted'} disabled={busy}
                        aria-label={`Accept ${s.title} by ${s.artist}`}>Accept</Button>
                      <Button size="sm" variant="secondary" onClick={() => onDecide(s, 'dismissed')} loading={busy && pending?.decision === 'dismissed'} disabled={busy}
                        aria-label={`Dismiss ${s.title} by ${s.artist}`}>Dismiss</Button>
                    </div>
                    {error && <p className={styles.error} role="alert">{error}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** What the row says when a decision did not go through: the server's words (a 403 or 404 from the app included). */
export function decisionError(err: unknown): string {
  const e = err as { detail?: string; title?: string } | null;
  return e?.detail || e?.title || 'The decision did not go through. Try again.';
}

export function WantlistSection() {
  const { libraryId } = useCurrentLibrary();
  const wantlist = useWantlist(libraryId);
  const decide = useWantlistDecision(libraryId);
  const [pending, setPending] = useState<{ id: string; decision: WantlistDecision } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const view = wantlist.data;
  if (!view || (!view.available && view.wantlist.length === 0)) return null;
  const onDecide = (s: WantlistSuggestionView, decision: WantlistDecision) => {
    setPending({ id: s.id, decision });
    setErrors(({ [s.id]: _drop, ...rest }) => rest);
    decide.mutate({ id: s.id, decision }, {
      onError: (err) => setErrors((prev) => ({ ...prev, [s.id]: decisionError(err) })),
      onSettled: () => setPending(null),
    });
  };
  return <WantlistPanel view={view} pending={pending} errors={errors} onDecide={onDecide} />;
}
