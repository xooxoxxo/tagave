import { ReactNode } from 'react';
import { Tabs, TabItem } from './Tabs';
import styles from './PageShell.module.css';

interface PageShellProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: TabItem[];
  activeTab?: string;
  onTabChange?: (value: string) => void;
  children: ReactNode;
}

export function PageShell({
  title,
  subtitle,
  actions,
  tabs,
  activeTab = '',
  onTabChange,
  children,
}: PageShellProps) {
  return (
    <div className={styles.pageShell}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{title}</h1>
          {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>

      {tabs && tabs.length > 0 && (
        <div style={{ paddingLeft: 'var(--page-pad)', paddingRight: 'var(--page-pad)' }}>
          <Tabs items={tabs} value={activeTab} onChange={onTabChange} />
        </div>
      )}

      <div className={styles.content}>{children}</div>
    </div>
  );
}
