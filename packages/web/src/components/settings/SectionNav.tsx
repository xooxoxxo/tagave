/**
 * The section list of a settings page (Your settings, Settings): search
 * first when the page has it, then one link per section, the current one
 * marked. A pure view: the page decides what it lists. It stays put while
 * the section beside it scrolls (the page's `className` makes it sticky),
 * and when it is taller than the pane the current section is brought into
 * it.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { UpdateDot } from '../UpdateDot';
import styles from './SectionNav.module.css';

export interface SectionNavItem {
  value: string;
  label: string;
  to: string;
  /** the owner's update dot (Updates) */
  dot?: boolean;
  /** a quiet label above the first item of each group */
  group?: string;
  /** a quiet second line in the link (Settings search: the labels that matched) */
  detail?: string;
}

export interface SectionNavProps {
  /** the nav's accessible name */
  label: string;
  items: SectionNavItem[];
  /** the section shown, or null when none is marked */
  current: string | null;
  /** above the links (Settings' search) */
  search?: ReactNode;
  /** a value line when nothing is listed (`No match`) */
  empty?: string;
  /** the page's placement of the list (sticky beside the section) */
  className?: string | undefined;
}

export function SectionNav({ label, items, current, search, empty, className }: SectionNavProps) {
  const ref = useActiveInView<HTMLElement>(current);
  return (
    <nav ref={ref} className={className ? `${styles.nav} ${className}` : styles.nav} aria-label={label}>
      {search}
      {items.length === 0 && empty && <p className={styles.empty}>{empty}</p>}
      {items.map((item, i) => {
        const here = item.value === current;
        return (
          <div key={item.value}>
            {item.group && item.group !== items[i - 1]?.group && <p className={styles.groupLabel}>{item.group}</p>}
            <Link to={item.to as never} className={here ? styles.activeSection : styles.sectionLink} aria-current={here ? 'page' : undefined}>
              {item.label}{item.dot && <UpdateDot />}
              {item.detail && <span className={styles.detail}>{item.detail}</span>}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}

/** Brings the current section into the list when the list scrolls on its own. */
function useActiveInView<T extends HTMLElement>(key: string | null) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const nav = ref.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollHeight <= nav.clientHeight) return;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < nav.scrollTop) nav.scrollTop = top;
    else if (bottom > nav.scrollTop + nav.clientHeight) nav.scrollTop = bottom - nav.clientHeight;
  }, [key]);
  return ref;
}
