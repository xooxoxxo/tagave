import { type ReactNode, useEffect, useId, useRef } from 'react';
import styles from './review.module.css';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal sheet on the scrim, built like ConfirmDialog: a native <dialog>
 * (the page behind is inert), Tab stays inside, Esc or the backdrop closes,
 * and focus returns to whatever opened it.
 */
export function ReviewDialog({ title, onClose, children, footer, wide = false }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement as HTMLElement | null;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`${styles.dialog} ${wide ? styles.dialogWide : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
          return;
        }
        if (e.key !== 'Tab') return;
        const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className={styles.dialogPanel}>
        <div className={styles.dialogHead}>
          <h2 id={titleId} className={styles.dialogTitle}>{title}</h2>
          <button type="button" className={styles.dialogClose} onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
        {children}
        {footer && <div className={styles.dialogActions}>{footer}</div>}
      </div>
    </dialog>
  );
}

/** Every shortcut of the review screen; the bar shows none of them. */
export const REVIEW_SHORTCUTS: ReadonlyArray<readonly [keys: readonly string[], what: string]> = [
  [['↵'], 'Accept the selected edition'],
  [['a'], 'Keep the album as it is'],
  [['x'], 'Ignore this album'],
  [['e'], 'Exclude the selected edition'],
  [['↑', '↓'], 'Previous / next edition'],
  [['n', 'p'], 'Next / previous album (also j, k)'],
  [['/'], 'Paste an edition link'],
  [['?'], 'Show this list'],
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <ReviewDialog title="Keyboard shortcuts" onClose={onClose}>
      <dl className={styles.keys}>
        {REVIEW_SHORTCUTS.map(([keys, what]) => (
          <div key={what} className={styles.keyRow}>
            <dt>{keys.map((k) => <kbd key={k} className={styles.kbd}>{k}</kbd>)}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </ReviewDialog>
  );
}
