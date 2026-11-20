/**
 * A settings group of one row that opens another page: Your settings ›
 * Listening's `Player server` (the owner's part in Settings), a module
 * page's `Your listening` (the person's part in Your settings), the
 * Autotagger page's `Set up in Library care` (a tab, by `search`). So
 * nothing is set in two places.
 */
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, SettingsGroup, SettingsRow } from '../ui';
import styles from './LinkRow.module.css';

export interface LinkRowProps {
  /** the group's title */
  group: string;
  /** the row's label, and the link's accessible name */
  label: string;
  to: string;
  /** the link's query, e.g. `{ tab: 'autotagger' }` */
  search?: Record<string, string> | undefined;
  className?: string | undefined;
}

export function LinkRow({ group, label, to, search, className }: LinkRowProps) {
  return (
    <SettingsGroup title={group} className={className ?? ''}>
      <SettingsRow label={label} as="div">
        <Link to={to as never} {...(search ? { search: search as never } : {})} className={styles.rowLink} aria-label={label}>
          <ChevronRightIcon />
        </Link>
      </SettingsRow>
    </SettingsGroup>
  );
}
