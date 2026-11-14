/**
 * The foot of the desktop sidebar, over the player bar: the pages that
 * belong to the person and the library (Listening, Library care, Tag
 * changes, Settings) as a second, quieter list, the colour theme, and the
 * signed-in person on the last row. Nothing opens on a press: the name
 * leads to Account, the key beside it signs out.
 *
 * Owner, 2026-11-14: "the profile should no longer be in the bottom bar,
 * sidebar should always be above footer … if we don't have many items we
 * can even also add them to menu instead of click for menu" (option A,
 * "Listed"). Tablet and phone keep the AccountCompartment.
 */
import { useId, type MouseEvent } from 'react';
import { SegmentedControl, type SegmentedOption } from './ui/SegmentedControl';
import { useThemePreference, type ThemePreference } from '../theme';
import { accountInitial, type CompartmentLink } from './AccountCompartment';
import styles from './SidebarAccount.module.css';

/** A page in the list: a real link (a new tab works), the app's own navigation on a plain press. */
export interface SidebarAccountLink extends CompartmentLink {
  href: string;
}

export interface SidebarAccountProps {
  name: string;
  email: string;
  links: SidebarAccountLink[];
  account: { href: string; current?: boolean; onSelect: () => void };
  onSignOut: () => void;
  signingOut?: boolean;
  /** signing out failed */
  signOutFailed?: boolean;
}

const themeOptions: SegmentedOption<ThemePreference>[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Auto' },
];

/** A plain press stays in the app; a modified or middle press is the browser's. */
function follow(onSelect: () => void) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onSelect();
  };
}

export function SidebarAccount({ name, email, links, account, onSignOut, signingOut = false, signOutFailed = false }: SidebarAccountProps) {
  const [theme, setTheme] = useThemePreference();
  const id = useId();
  const shown = name.trim() || email;
  return (
    <div className={styles.root} data-account-row="">
      <nav className={styles.links} aria-label="Library and settings">
        {links.map((l) => (
          <a key={l.key} href={l.href} className={l.current ? styles.linkCurrent : styles.link} aria-current={l.current ? 'page' : undefined} onClick={follow(l.onSelect)}>
            <span className={styles.label}>{l.label}</span>
            {!!l.count && <span className={styles.count}><span className={styles.srOnly}>, </span>{l.count}<span className={styles.srOnly}> {l.countLabel ?? 'waiting'}</span></span>}
            {l.dot && <span className={styles.dot} title={l.dot}><span className={styles.srOnly}> ({l.dot})</span></span>}
          </a>
        ))}
      </nav>
      <div className={styles.appearance}>
        <SegmentedControl size="sm" label="Appearance" name={`${id}-theme`} value={theme} onChange={setTheme} options={themeOptions} />
      </div>
      {signOutFailed && <p role="alert" className={styles.error}>Could not sign out. Please try again.</p>}
      <div className={styles.person}>
        <a href={account.href} className={account.current ? styles.whoCurrent : styles.who} aria-current={account.current ? 'page' : undefined} aria-label={`Account: ${shown}`} onClick={follow(account.onSelect)}>
          <span className={styles.tile} aria-hidden="true">{accountInitial(name, email)}</span>
          <span className={styles.text} aria-hidden="true">
            <span className={styles.name}>{shown}</span>
            <span className={styles.sub}>Account</span>
          </span>
        </a>
        <button type="button" className={styles.signOut} aria-label={signingOut ? 'Signing out' : 'Sign out'} title="Sign out" disabled={signingOut} onClick={onSignOut}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" /><path d="m14 8 4 4-4 4" /><path d="M18 12H9" /></svg>
        </button>
      </div>
    </div>
  );
}
