/**
 * The signed-in person, at the foot of the sidebar: an initial tile, the
 * name and the email address as one button that opens a menu (Account,
 * Listening, Sign out), the way Linear, Slack or Spotify keep the account.
 * No divider above it. On a desktop the row is exactly as tall as the
 * player bar and shares its top edge, so the two read as one strip
 * (Layout.module.css `.account`); on a tablet the tile alone sits in the
 * bar's corner, on a phone the row ends the menu sheet.
 *
 * Owner, 2026-10-20: "that user account thingy sucks ... make it smooth so
 * that bottom part is aligned with the now playing or have no separator
 * line at all".
 */
import { Menu, type MenuItem } from './ui/Menu';
import styles from './AccountMenu.module.css';

export interface AccountMenuProps {
  name: string;
  email: string;
  onAccount: () => void;
  onListening: () => void;
  onSignOut: () => void;
  signingOut?: boolean;
  className?: string;
}

/** The tile's letter: the name's first, else the address's. */
export function accountInitial(name: string, email: string): string {
  const first = [...(name.trim() || email.trim())][0] ?? '?';
  return first.toLocaleUpperCase();
}

export function AccountMenu({ name, email, onAccount, onListening, onSignOut, signingOut = false, className }: AccountMenuProps) {
  const shown = name.trim() || email;
  const items: MenuItem[] = [
    { key: 'account', label: 'Account', hint: email, onSelect: onAccount },
    { key: 'listening', label: 'Listening', onSelect: onListening },
    { key: 'signout', label: signingOut ? 'Signing out…' : 'Sign out', disabled: signingOut, onSelect: onSignOut },
  ];
  return (
    <Menu
      label={`Account: ${shown}`}
      items={items}
      className={[styles.anchor, className].filter(Boolean).join(' ')}
      triggerClassName={`${styles.button}`}
      icon={(
        <>
          <span className={styles.tile} aria-hidden="true">{accountInitial(name, email)}</span>
          <span className={styles.text} aria-hidden="true">
            <span className={styles.name}>{shown}</span>
            {shown !== email && <span className={styles.email}>{email}</span>}
          </span>
        </>
      )}
    />
  );
}
