import { type ReactNode, useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { Button } from './Button';
import styles from './ConfirmDialog.module.css';

/**
 * The in-app replacement for window.confirm(). A modal <dialog>: the page
 * behind it is inert, Tab stays inside it, Esc or the backdrop cancels, and
 * focus goes back to whatever opened it.
 *
 *   if (!(await confirmDialog({ title: 'Delete this view?', tone: 'danger', confirmLabel: 'Delete' }))) return;
 *
 * `<ConfirmHost />` is mounted once at the root and renders the open request.
 */
export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger: the confirm button is the danger drop and focus starts on Cancel. */
  tone?: 'primary' | 'danger';
}

interface Pending extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

let current: Pending | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Ask; resolves true on confirm, false on cancel, Esc or backdrop. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // A second request replaces the first, which counts as cancelled.
    current?.resolve(false);
    current = { ...options, id: nextId++, resolve };
    emit();
  });
}

function settle(ok: boolean) {
  const pending = current;
  current = null;
  emit();
  pending?.resolve(ok);
}

export function ConfirmHost() {
  const pending = useSyncExternalStore(subscribe, () => current, () => null);
  if (!pending) return null;
  return <ConfirmDialog key={pending.id} {...pending} onResult={settle} />;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  tone = 'primary',
  onResult,
}: ConfirmOptions & { onResult: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement as HTMLElement | null;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    (tone === 'danger' ? cancelRef : confirmRef).current?.focus();
    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      if (opener && opener.isConnected) opener.focus();
    };
  }, [tone]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={message ? messageId : undefined}
      // Esc fires `cancel`; keep the dialog mounted state in React's hands.
      onCancel={(e) => {
        e.preventDefault();
        onResult(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onResult(false);
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
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => {
        if (e.target === ref.current) onResult(false);
      }}
    >
      <div className={styles.panel}>
        <h2 id={titleId} className={styles.title}>{title}</h2>
        {message && <div id={messageId} className={styles.message}>{message}</div>}
        <div className={styles.actions}>
          <Button ref={cancelRef} variant="secondary" onClick={() => onResult(false)}>{cancelLabel}</Button>
          <Button ref={confirmRef} variant={tone === 'danger' ? 'danger' : 'primary'} onClick={() => onResult(true)}>{confirmLabel}</Button>
        </div>
      </div>
    </dialog>
  );
}
