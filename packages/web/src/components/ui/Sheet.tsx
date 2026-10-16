/**
 * A sheet: a panel that slides in from the bottom edge (a phone's action
 * drawer) or the right edge (a desktop's side sheet), on Base UI's Drawer
 * (the drawer shadcn now uses in place of vaul). Drag it down (or right) to
 * close it, press Escape, or tap outside; focus stays inside while it is
 * open and goes back to the button that opened it (`returnFocus`).
 *
 * Only `@base-ui/react/drawer` is imported, so the rest of Base UI stays out
 * of the bundle; import this file directly (it is not in the ui barrel), so
 * only the pages that open a sheet load it.
 */
import type { ReactNode, RefObject } from 'react';
import { Drawer } from '@base-ui/react/drawer';
import styles from './Sheet.module.css';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the sheet's name for screen readers (shown only to them) */
  title: string;
  /** the bottom edge (phone) or the right edge (desktop side sheet) */
  side?: 'bottom' | 'right';
  /** where focus goes when it closes: the button that opened it */
  returnFocus?: RefObject<HTMLElement | null> | undefined;
  children: ReactNode;
  className?: string | undefined;
}

export function Sheet({ open, onOpenChange, title, side = 'bottom', returnFocus, children, className }: SheetProps) {
  return (
    <Drawer.Root open={open} onOpenChange={(next) => onOpenChange(next)} swipeDirection={side === 'right' ? 'right' : 'down'}>
      <Drawer.Portal>
        <Drawer.Backdrop className={styles.backdrop} />
        <Drawer.Viewport className={side === 'right' ? `${styles.viewport} ${styles.viewportRight}` : styles.viewport}>
          <Drawer.Popup
            className={[styles.popup, side === 'right' ? styles.right : styles.bottom, className].filter(Boolean).join(' ')}
            data-sheet={side}
            {...(returnFocus ? { finalFocus: returnFocus } : {})}
          >
            {side === 'bottom' && <div className={styles.grab} aria-hidden="true" />}
            <Drawer.Content className={styles.content}>
              <Drawer.Title className={styles.srOnly}>{title}</Drawer.Title>
              {children}
              <Drawer.Close className={styles.srOnly}>Close</Drawer.Close>
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
