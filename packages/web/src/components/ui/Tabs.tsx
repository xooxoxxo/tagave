import { ReactNode, useEffect, useRef } from 'react';
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
}

export function Tabs({ items, value, onChange }: TabsProps) {
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;

      const currentIndex = items.findIndex((item) => item.value === value);
      if (currentIndex === -1) return;

      e.preventDefault();
      let nextIndex = currentIndex;

      if (e.key === 'ArrowLeft') {
        nextIndex = currentIndex === 0 ? items.length - 1 : currentIndex - 1;
      } else if (e.key === 'ArrowRight') {
        nextIndex = currentIndex === items.length - 1 ? 0 : currentIndex + 1;
      }

      const nextItem = items[nextIndex];
      if (!nextItem) return;

      const nextValue = nextItem.value;
      if (onChange) onChange(nextValue);

      setTimeout(() => {
        const nextTab = tabRefs.current.get(nextValue);
        if (nextTab) nextTab.focus();
      }, 0);
    };

    const activeTab = tabRefs.current.get(value);
    if (activeTab) {
      activeTab.addEventListener('keydown', handleKeyDown);
      return () => activeTab.removeEventListener('keydown', handleKeyDown);
    }
  }, [items, value, onChange]);

  return (
    <div className={styles.tablist} role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          ref={(el) => {
            if (el) tabRefs.current.set(item.value, el);
          }}
          role="tab"
          aria-selected={item.value === value}
          aria-controls={`${item.value}-panel`}
          className={[
            styles.tab,
            item.value === value ? styles.active : styles.inactive,
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => {
            if (item.onClick) item.onClick();
            if (onChange) onChange(item.value);
          }}
        >
          <span className={styles.label}>{item.label}</span>
          {item.count !== undefined && (
            <span className={styles.count}>{item.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
