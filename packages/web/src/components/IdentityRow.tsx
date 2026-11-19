/**
 * The top of the sidebar: the mark (it leads home), the "tagave" wordmark
 * when the Appearance pref shows it, search when it sits beside, and the
 * person's monogram. The monogram opens one menu: Your settings, Settings
 * (for those who look after the library) and Sign out. The owner's update
 * dot sits on the monogram. Replaces the brand row and both account pieces
 * (spec §1).
 */
import type { MouseEvent, ReactNode } from 'react';
import { BrandMark } from './BrandMark';
import { Menu, type MenuItem } from './ui/Menu';
import { accountInitial } from './accountInitial';
import { identityMenu } from './navModel';
import styles from './IdentityRow.module.css';

export interface IdentityRowProps {
  name: string;
  email: string;
  showWordmark: boolean;
  /** search, when it sits in this row (between the wordmark and the monogram) */
  search?: ReactNode;
  canCare: boolean;
  /** the monogram's dot as words (identityDot), or null for none */
  dot: string | null;
  onNavigate: (to: string) => void;
  onSignOut: () => void;
  signingOut?: boolean;
  /** signing out failed */
  signOutFailed?: boolean;
}

export function IdentityRow({ name, email, showWordmark, search, canCare, dot, onNavigate, onSignOut, signingOut = false, signOutFailed = false }: IdentityRowProps) {
  const shown = name.trim() || email;
  // a plain press stays in the app; a modified or middle press is the browser's
  const home = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onNavigate('/');
  };
  const items: MenuItem[] = identityMenu({ canCare }).map((item) =>
    item.key === 'signout'
      ? { key: item.key, label: signingOut ? 'Signing out' : item.label, disabled: signingOut, separated: true, onSelect: onSignOut }
      : { key: item.key, label: item.label, onSelect: () => item.to && onNavigate(item.to) },
  );
  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <a href="/" className={styles.brand} aria-label="tagave" onClick={home}>
          <BrandMark className={styles.mark} />
          {showWordmark && <span className={styles.wordmark}>tagave</span>}
        </a>
        {search && <div className={styles.search}>{search}</div>}
        <Menu
          label={`Account: ${shown}${dot ? `, ${dot}` : ''}`}
          className={styles.person ?? ''}
          triggerClassName={styles.tile ?? ''}
          icon={
            <>
              <span aria-hidden="true">{accountInitial(name, email)}</span>
              {dot && <span className={styles.dot} aria-hidden="true" />}
            </>
          }
          heading={
            <span className={styles.who}>
              <span className={styles.name}>{shown}</span>
              <span className={styles.email}>{email}</span>
            </span>
          }
          items={items}
        />
      </div>
      {signOutFailed && <p role="alert" className={styles.error}>Could not sign out. Please try again.</p>}
    </div>
  );
}
