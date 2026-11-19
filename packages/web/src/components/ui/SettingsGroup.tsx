/**
 * The grouped settings list (the Backups pattern): a small uppercase head
 * (title, optional `?` help, a save status, a meta value on the right), then
 * the rows on one surface. A row is a label on the left and one compact
 * control (or a value) on the right, rows divided by a hairline.
 */
import type { ReactNode } from 'react';
import { Surface } from './Card';
import { HelpToggle } from './HelpToggle';
import styles from './SettingsGroup.module.css';

export interface SettingsGroupProps {
  title: string;
  /** Behind a `?` beside the title. */
  help?: ReactNode;
  /** Right-aligned in the head, e.g. "3 · 1.2 MB". */
  meta?: ReactNode;
  /** Beside the title, e.g. "✓ Saved" or why it was not. */
  status?: ReactNode;
  /** The rows; they share one surface. A group with none has no surface. */
  children?: ReactNode;
  /** More inside the section, below the rows' surface (Backups lists its files there). */
  after?: ReactNode;
  className?: string;
}

export function SettingsGroup({ title, help, meta, status, children, after, className }: SettingsGroupProps) {
  return (
    <section aria-label={title} className={[styles.group, className].filter(Boolean).join(' ')}>
      <div className={styles.groupHead}>
        <h3 className={styles.groupTitle}>{title}</h3>
        {help && <HelpToggle label={title}>{help}</HelpToggle>}
        {status}
        {meta && <span className={styles.groupMeta}>{meta}</span>}
      </div>
      {children && <Surface padded={false} className={styles.list}>{children}</Surface>}
      {after}
    </section>
  );
}

export interface SettingsRowProps {
  label: string;
  /** Behind a `?` beside the label. */
  help?: ReactNode;
  /** A read-only value on the right, before any control. */
  value?: ReactNode;
  /** The control. */
  children?: ReactNode;
  /** 'label' (default) wraps one control so clicking the label focuses it; 'div' when the control is a group (SegmentedControl). */
  as?: 'label' | 'div';
}

export function SettingsRow({ label, help, value, children, as = 'label' }: SettingsRowProps) {
  const Tag = as;
  if (!help) {
    return (
      <Tag className={styles.row}>
        <span className={styles.rowLabel}>{label}</span>
        {value}
        {children}
      </Tag>
    );
  }
  // A button inside a <label> would take the label from the control, so with
  // help the row is a div: the label (laid out as if it were not there) still
  // wraps the text and the control, and the `?` sits outside it, after the text.
  return (
    <div className={`${styles.row} ${styles.withHelp}`}>
      <Tag className={styles.rowField}>
        <span className={styles.rowLabel}>{label}</span>
        <span className={styles.rowControl}>{value}{children}</span>
      </Tag>
      <HelpToggle label={label}>{help}</HelpToggle>
    </div>
  );
}
