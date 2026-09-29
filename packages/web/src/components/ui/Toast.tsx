import { type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { Button } from './Button';
import styles from './Toast.module.css';

/**
 * One short-lived glass note at the foot of the screen, with at most one
 * action (Undo). A new toast replaces the one showing; it leaves on its own
 * after `durationMs`, or when dismissed. Screen readers hear it through a
 * polite live region (assertive for errors).
 *
 *   const t = showToast({ message: 'Added to your physical collection', action: { label: 'Undo', onClick: undo } });
 *   updateToast(t, { message: '…' });
 *
 * `<ToastHost />` is mounted once at the root, next to `<ConfirmHost />`.
 */
export interface ToastOptions {
  message: ReactNode;
  action?: { label: string; onClick: () => void } | undefined;
  tone?: 'neutral' | 'danger';
  /** ms before it leaves on its own; 0 keeps it until replaced or dismissed */
  durationMs?: number;
}

interface Current extends ToastOptions {
  id: number;
}

let current: Current | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function showToast(options: ToastOptions): number {
  current = { durationMs: 8000, ...options, id: nextId++ };
  emit();
  return current.id;
}

/** Change the toast `id` if it is still the one showing. */
export function updateToast(id: number, options: Partial<ToastOptions>): void {
  if (current?.id !== id) return;
  current = { ...current, ...options };
  emit();
}

export function dismissToast(id?: number): void {
  if (!current || (id !== undefined && current.id !== id)) return;
  current = null;
  emit();
}

export function ToastHost() {
  const toast = useSyncExternalStore(subscribe, () => current, () => null);
  useEffect(() => {
    if (!toast || !toast.durationMs) return;
    const t = setTimeout(() => dismissToast(toast.id), toast.durationMs);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <div className={styles.region} role={toast?.tone === 'danger' ? 'alert' : 'status'} aria-live={toast?.tone === 'danger' ? 'assertive' : 'polite'}>
      {toast && (
        <div key={toast.id} className={[styles.toast, toast.tone === 'danger' ? styles.danger : undefined].filter(Boolean).join(' ')}>
          <span className={styles.message}>{toast.message}</span>
          {toast.action && (
            <Button size="sm" variant="secondary" onClick={() => { const a = toast.action!; dismissToast(toast.id); a.onClick(); }}>
              {toast.action.label}
            </Button>
          )}
          <button type="button" className={styles.close} aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>×</button>
        </div>
      )}
    </div>
  );
}
