import { ReactNode } from 'react';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = 'neutral', children, className }: BadgeProps) {
  return (
    <span className={[styles.badge, styles[`tone-${tone}`], className].filter(Boolean).join(' ')}>
      {children}
    </span>
  );
}

/**
 * Map plan/job status to a badge tone
 */
export function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'draft':
      return 'neutral';
    case 'previewed':
      return 'info';
    case 'applying':
      return 'warning';
    case 'paused':
      return 'warning';
    case 'applied':
      return 'success';
    case 'partially_failed':
      return 'warning';
    case 'cancelled':
      return 'neutral';
    case 'reverted':
      return 'neutral';
    case 'running':
      return 'warning';
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}
