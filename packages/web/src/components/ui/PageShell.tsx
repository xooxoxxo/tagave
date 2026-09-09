import { ReactNode, useId } from 'react';
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
  const panelId = useId();
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
        <div className={styles.tabs}>
          <Tabs panelId={panelId} items={tabs} value={activeTab} onChange={onTabChange} />
        </div>
      )}

      <div className={styles.content} id={tabs?.length ? panelId : undefined} role={tabs?.length ? "tabpanel" : undefined}>{children}</div>
    </div>
  );
}
