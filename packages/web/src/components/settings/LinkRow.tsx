/**
 * A settings group of one row that opens another page: Your settings ›
 * Listening's `Player server` (the owner's part in Settings), a module
 * page's `Your listening` (the person's part in Your settings). So nothing
 * is set in two places.
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
  className?: string | undefined;
}

export function LinkRow({ group, label, to, className }: LinkRowProps) {
  return (
    <SettingsGroup title={group} className={className ?? ''}>
      <SettingsRow label={label} as="div">
        <Link to={to as never} className={styles.rowLink} aria-label={label}>
          <ChevronRightIcon />
        </Link>
      </SettingsRow>
    </SettingsGroup>
  );
}
