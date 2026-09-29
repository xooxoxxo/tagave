import { cloneElement, isValidElement, useEffect, useId, useState, type ReactElement, type ReactNode } from 'react';
import styles from './Tooltip.module.css';

interface TooltipProps {
  /** Short supplementary text. Never the only place important information lives. */
  content: ReactNode;
  /** One focusable element (a button, a link). It gets aria-describedby. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  side?: 'top' | 'bottom';
}

/**
 * A small glass label that appears on hover and keyboard focus, and closes on
 * Escape, blur or pointer leave (WCAG 1.4.13: dismissible, hoverable, persistent).
 */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (!isValidElement(children)) return children;
  const describedBy = [children.props['aria-describedby'], id].filter(Boolean).join(' ');
  return <span
    className={styles.anchor}
    onPointerEnter={() => setOpen(true)}
    onPointerLeave={() => setOpen(false)}
    onFocus={() => setOpen(true)}
    onBlur={() => setOpen(false)}
  >
    {cloneElement(children, { 'aria-describedby': describedBy })}
    <span role="tooltip" id={id} className={[styles.tip, styles[side], open ? styles.open : undefined].filter(Boolean).join(' ')}>{content}</span>
  </span>;
}
