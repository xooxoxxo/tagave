import { ReactNode } from 'react';
import styles from './EmptyState.module.css';

interface EmptyStateProps {
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, text, action }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <div className={styles.content}>
        <h3 className={styles.title}>{title}</h3>
        {text && <p className={styles.text}>{text}</p>}
        {action && <div className={styles.action}>{action}</div>}
      </div>
    </div>
  );
}
