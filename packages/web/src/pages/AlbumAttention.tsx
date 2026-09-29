/**
 * The attention strip: compact rows, one line and one action each. Pressing a
 * row's line opens it in place (the Collapse accordion: the rows below are
 * pushed smoothly, nothing jumps); the action either acts at once or opens
 * the row. The first row that needs a decision carries the page's one primary
 * button; every other action uses the one secondary style.
 */
import type { ReactNode } from 'react';
import { Button, Collapse } from '../components/ui';
import type { AttentionItem } from '../utils/albumAttention';
import styles from './AlbumAttention.module.css';

export interface AlbumAttentionProps {
  items: AttentionItem[];
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onAction: (item: AttentionItem) => void;
  /** the expanded body of a row */
  body: (item: AttentionItem) => ReactNode;
  /** per-row busy state for actions that act at once */
  busy?: (item: AttentionItem) => boolean;
  label: string;
}

export function AlbumAttention({ items, open, onToggle, onAction, body, busy, label }: AlbumAttentionProps) {
  if (items.length === 0) return null;
  const primaryId = items.find((i) => i.tone === 'attention')?.id;
  return (
    <section className={styles.strip} aria-label={label}>
      <ul className={styles.rows}>
        {items.map((item) => {
          const isOpen = open.has(item.id);
          const bodyId = `attention-${item.id.replace(/[^a-z0-9-]/gi, '')}`;
          const action = item.action;
          // An "open the row" action has nothing left to do once the row is
          // open: it fades out but keeps its slot, so the header never re-flows.
          const hideAction = !!action && action.do === 'expand' && isOpen;
          return (
            <li key={item.id} className={`${styles.row} ${isOpen ? styles.rowOpen : ''}`} data-tone={item.tone}>
              {/* One grid for every row: line · action slot (fixed width) ·
                  chevron (fixed column), so actions and chevrons line up down
                  the strip. The line's button stretches over the whole row, so
                  a press anywhere but the action opens it. */}
              <div className={styles.head}>
                <button type="button" className={styles.toggle} aria-expanded={isOpen} aria-controls={bodyId} onClick={() => onToggle(item.id)}>
                  <span className={styles.dot} aria-hidden="true" />
                  <span className={styles.line}>{item.line}</span>
                </button>
                <div className={`${styles.actionSlot} ${hideAction ? styles.actionHidden : ''}`}>
                  {action && (
                    <Button
                      variant={item.id === primaryId ? 'primary' : 'secondary'}
                      size="sm"
                      className={styles.action}
                      loading={busy?.(item) ?? false}
                      tabIndex={hideAction ? -1 : undefined}
                      aria-hidden={hideAction || undefined}
                      aria-expanded={action.do === 'expand' ? false : undefined}
                      aria-controls={action.do === 'expand' ? bodyId : undefined}
                      onClick={() => (action.do === 'expand' ? onToggle(item.id) : onAction(item))}
                    >
                      {action.label}
                    </Button>
                  )}
                </div>
                <span className={styles.chevron} aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                </span>
              </div>
              <Collapse open={isOpen} id={bodyId}>
                <div className={styles.body}>{body(item)}</div>
              </Collapse>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
