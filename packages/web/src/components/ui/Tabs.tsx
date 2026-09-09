import { type ReactNode, useRef } from 'react';
import { nextTabIndex } from './tabNavigation';
import styles from './Tabs.module.css';

export interface TabItem {
  label: ReactNode;
  value: string;
  to?: string;
  onClick?: () => void;
  count?: number;
}
interface TabsProps {
  items: TabItem[];
  value: string;
  onChange?: ((value: string) => void) | undefined;
  label?: string;
  /** ID of the actual panel rendered by the caller. Omit when no panel exists. */
  panelId?: string;
}

export function Tabs({ items, value, onChange, label = 'Sections', panelId }: TabsProps) {
  const refs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const activate = (item: TabItem) => { item.onClick?.(); onChange?.(item.value); };
  return <div className={styles.tablist} role="tablist" aria-label={label}>
    {items.map((item, index) => <button
      type="button"
      key={item.value}
      ref={element => { if (element) refs.current.set(item.value, element); else refs.current.delete(item.value); }}
      role="tab"
      tabIndex={item.value === value ? 0 : -1}
      aria-selected={item.value === value}
      aria-controls={panelId}
      className={[styles.tab, item.value === value ? styles.active : styles.inactive].join(' ')}
      onClick={() => activate(item)}
      onKeyDown={event => {
        const next = nextTabIndex(event.key, index, items.length);
        if (next === undefined) return;
        const target = items[next];
        if (!target) return;
        event.preventDefault();
        activate(target);
        refs.current.get(target.value)?.focus();
      }}
    ><span className={styles.label}>{item.label}</span>{item.count !== undefined && <span className={styles.count}>{item.count}</span>}</button>)}
  </div>;
}
