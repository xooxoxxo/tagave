import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Button';
import styles from './Menu.module.css';

export interface MenuItem {
  key: string;
  label: ReactNode;
  /** one quiet line under the label */
  hint?: ReactNode;
  onSelect?: () => void;
  /** an external link instead of an action (opens in a new tab) */
  href?: string;
  disabled?: boolean;
  tone?: 'danger';
  /** a hairline above this item, starting a new group */
  separated?: boolean;
}

export interface MenuProps {
  /** the trigger's accessible name, e.g. "More for this album" */
  label: string;
  items: MenuItem[];
  /** a short heading inside the menu */
  heading?: ReactNode;
  /** trigger icon; three dots by default */
  icon?: ReactNode;
  className?: string;
}

export function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

/**
 * The "⋯" menu: a clear bubble that opens a glass list of actions. Arrow
 * keys, Home and End move between items, Enter picks, Escape or a click
 * outside closes and focus returns to the trigger. The list is placed in the
 * viewport (fixed), flipping above the trigger when there is no room below,
 * and closes when the page scrolls under it. It renders into <body>, so no
 * stacking context on the page can cover it.
 */
export function Menu({ label, items, heading, icon, className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // phones: a sheet from the bottom edge, like a music app's track menu
  const [sheet, setSheet] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setPos(null);
    if (refocus) trigger.current?.focus();
  }, []);

  const place = useCallback(() => {
    if (globalThis.matchMedia?.('(max-width: 640px)').matches) {
      setSheet(true);
      setPos({ top: 0, left: 0 });
      return;
    }
    setSheet(false);
    const t = trigger.current?.getBoundingClientRect();
    const m = list.current;
    if (!t || !m) return;
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(8, t.right - w), vw - w - 8);
    const below = t.bottom + 6;
    const top = below + h > vh - 8 && t.top - 6 - h > 8 ? t.top - 6 - h : below;
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const first = list.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
    first?.focus({ preventScroll: true });
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (list.current?.contains(t) || trigger.current?.contains(t)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      if (list.current?.contains(e.target as Node)) return;
      close(false);
    };
    const onResize = () => close(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const els = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); els[(n + els.length) % els.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(els.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    // Tab: focus goes back to the trigger first, so the browser's own Tab
    // continues from there (the menu is portalled to the end of <body>).
    else if (e.key === 'Tab') close(true);
  };

  const pick = (item: MenuItem) => {
    if (item.disabled) return;
    close();
    item.onSelect?.();
  };

  return (
    <span className={[styles.anchor, className].filter(Boolean).join(' ')}>
      <IconButton
        ref={trigger}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true); }
        }}
      >
        {icon ?? <MoreIcon />}
      </IconButton>
      {open && typeof document !== 'undefined' && createPortal(
        <>
        {sheet && <div className={styles.scrim} aria-hidden="true" />}
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          className={sheet ? `${styles.menu} ${styles.sheet}` : styles.menu}
          style={sheet ? undefined : pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
          onKeyDown={onKeyDown}
        >
          {heading && <div className={styles.heading} role="presentation">{heading}</div>}
          {items.map((item) => {
            const cls = [styles.item, item.tone === 'danger' ? styles.danger : '', item.separated ? styles.separated : ''].filter(Boolean).join(' ');
            const body = (
              <>
                <span className={styles.itemLabel}>{item.label}</span>
                {item.hint && <span className={styles.itemHint}>{item.hint}</span>}
              </>
            );
            return item.href ? (
              <a key={item.key} role="menuitem" tabIndex={-1} className={cls} href={item.href} target="_blank" rel="noreferrer" onClick={() => close()}>
                {body}
              </a>
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={cls}
                aria-disabled={item.disabled || undefined}
                onClick={() => pick(item)}
              >
                {body}
              </button>
            );
          })}
        </div>
        </>,
        document.body,
      )}
    </span>
  );
}
