/**
 * The signed-in person at the foot of the sidebar, and the compartment it
 * opens. The row (initial tile, name, address) is a band as tall as the
 * player bar and as wide as the sidebar, painted like the bar, so with
 * something playing the foot of the screen reads as one strip. Pressing it
 * slides a section open directly above it, inside the sidebar, as if a
 * hidden compartment were revealed: Account, Listening, the colour theme,
 * Sign out (and, on a tablet, where the row is the tile alone, who is
 * signed in). Nothing floats and nothing in the sidebar
 * moves; the compartment grows up from the row.
 *
 * A disclosure, not a menu: the row says whether it is open and which
 * section it controls (aria-expanded, aria-controls), the section holds
 * ordinary buttons and a radio group, Tab walks them. Opening moves focus
 * into the section, closing (Escape, the row again, a press outside,
 * leaving the page) brings it back to the row.
 *
 * Owner, 2026-10-20: "instead open up a section in that place above the
 * user (on desktop) as if it was a hidden compartment that was revealed".
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { SegmentedControl, type SegmentedOption } from './ui/SegmentedControl';
import { useThemePreference, type ThemePreference } from '../theme';
import styles from './AccountCompartment.module.css';

export interface AccountCompartmentProps {
  name: string;
  email: string;
  onAccount: () => void;
  onListening: () => void;
  onSignOut: () => void;
  signingOut?: boolean;
  /** Changes on every navigation (the path): the compartment closes. */
  closeKey?: string;
  /** Open on first render (stories). */
  defaultOpen?: boolean;
  className?: string;
}

/** The tile's letter: the name's first, else the address's. */
export function accountInitial(name: string, email: string): string {
  const first = [...(name.trim() || email.trim())][0] ?? '?';
  return first.toLocaleUpperCase();
}

const themeOptions: SegmentedOption<ThemePreference>[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Auto' },
];

export function AccountCompartment({ name, email, onAccount, onListening, onSignOut, signingOut = false, closeKey, defaultOpen = false, className }: AccountCompartmentProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [theme, setTheme] = useThemePreference();
  const id = useId();
  const panelId = `${id}-compartment`;
  const root = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const shown = name.trim() || email;
  const initial = accountInitial(name, email);

  /** Close; focus goes back to the row when it was inside the compartment. */
  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus && root.current?.contains(document.activeElement)) row.current?.focus();
  }, []);

  // leaving the page closes it
  const lastKey = useRef(closeKey);
  useEffect(() => {
    if (lastKey.current === closeKey) return;
    lastKey.current = closeKey;
    close();
  }, [closeKey, close]);

  // a press anywhere else closes it, focus stays where the press put it
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) close(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, close]);

  // set by the row's press: the next render that opens moves focus inside
  const focusOnOpen = useRef(false);
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    // into the section, not onto its first button: no ring after a click,
    // and Tab goes on to Account
    panel.current?.focus({ preventScroll: true });
    // in the phone's sheet the row can sit low: once open, bring it all into view
    const t = window.setTimeout(() => root.current?.scrollIntoView?.({ block: 'nearest' }), 220);
    return () => window.clearTimeout(t);
  }, [open]);

  const toggle = () => {
    if (open) { close(); return; }
    focusOnOpen.current = true;
    setOpen(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !open) return;
    // the phone's menu sheet takes Escape too: this closes first
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const choose = (action: () => void) => () => { close(); action(); };

  return (
    <div ref={root} className={[styles.root, className].filter(Boolean).join(' ')} data-open={open || undefined} onKeyDown={onKeyDown}>
      {/* closed, visibility: hidden keeps it out of the tab order and the
          accessibility tree; it takes no presses while it folds away */}
      <div id={panelId} className={styles.compartment}>
        <div className={styles.clip}>
          <div ref={panel} className={styles.panel} tabIndex={-1} role="group" aria-label="Account">
            <div className={styles.identity}>
              <span className={styles.tile} aria-hidden="true">{initial}</span>
              <span className={styles.text}>
                <span className={styles.name}>{shown}</span>
                {shown !== email && <span className={styles.email}>{email}</span>}
              </span>
            </div>
            <div className={styles.items}>
              <button type="button" className={styles.item} onClick={choose(onAccount)}>Account</button>
              <button type="button" className={styles.item} onClick={choose(onListening)}>Listening</button>
              <div className={styles.appearance}>
                <span className={styles.appearanceLabel} aria-hidden="true">Appearance</span>
                <SegmentedControl size="sm" label="Appearance" name={`${id}-theme`} value={theme} onChange={setTheme} options={themeOptions} />
              </div>
              <button type="button" className={`${styles.item} ${styles.signOut}`} disabled={signingOut} onClick={() => { close(); onSignOut(); }}>
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </div>
        </div>
      </div>
      <button
        ref={row}
        type="button"
        className={styles.row}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account: ${shown}`}
        onClick={toggle}
      >
        <span className={styles.tile} aria-hidden="true">{initial}</span>
        <span className={styles.text} aria-hidden="true">
          <span className={styles.name}>{shown}</span>
          {shown !== email && <span className={styles.email}>{email}</span>}
        </span>
        <svg className={styles.chevron} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
      </button>
    </div>
  );
}
