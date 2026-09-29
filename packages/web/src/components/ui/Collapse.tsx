import { useState, type ReactNode } from 'react';
import styles from './Collapse.module.css';

export interface CollapseProps {
  open: boolean;
  children: ReactNode;
  id?: string;
  className?: string;
}

/**
 * Height animation without measuring: a one-row grid whose track goes from
 * 0fr to 1fr, so the content below is pushed smoothly and never jumps. The
 * content fades and settles 4px as it opens. Closed content is inert (not
 * focusable, not read out). Children mount on first open, so a closed row
 * costs nothing and never flashes; after that they stay, so closing animates.
 * Reduced motion switches instantly.
 */
export function Collapse({ open, children, id, className }: CollapseProps) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  return (
    <div id={id} className={[styles.collapse, open ? styles.open : '', className].filter(Boolean).join(' ')} data-open={open || undefined} inert={!open}>
      <div className={styles.inner}>
        <div className={styles.content}>{mounted ? children : null}</div>
      </div>
    </div>
  );
}
