import { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Chip.module.css';

export type ChipTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

interface ChipBaseProps {
  children: ReactNode;
  /** Selected filter: dew tint with a deep dew label. */
  active?: boolean;
  /** Leading 6px status dot. `true` uses the text colour; a tone colours it. */
  dot?: boolean | ChipTone;
  className?: string;
}

type StaticChipProps = ChipBaseProps & { onClick?: undefined };
type ToggleChipProps = ChipBaseProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> & { onClick: NonNullable<ButtonHTMLAttributes<HTMLButtonElement>['onClick']> };

/**
 * A small pill for filters and facts. With onClick it becomes a toggle button
 * (aria-pressed follows `active`); without, a plain label.
 */
export function Chip(props: StaticChipProps | ToggleChipProps) {
  const { children, active = false, dot, className, ...rest } = props;
  const cls = [styles.chip, active ? styles.active : undefined, className].filter(Boolean).join(' ');
  const dotEl = dot ? <span className={[styles.dot, typeof dot === 'string' ? styles[`dot-${dot}`] : undefined].filter(Boolean).join(' ')} aria-hidden="true" /> : null;
  if (rest.onClick) {
    const { type = 'button', ...buttonProps } = rest as ButtonHTMLAttributes<HTMLButtonElement>;
    return <button type={type} className={[cls, styles.interactive].join(' ')} aria-pressed={active} {...buttonProps}>{dotEl}{children}</button>;
  }
  return <span className={cls}>{dotEl}{children}</span>;
}
