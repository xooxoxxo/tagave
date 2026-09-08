import { Link, LinkProps } from '@tanstack/react-router';
import { ReactNode } from 'react';
import type { ButtonVariant, ButtonSize } from './Button';
import styles from './Button.module.css';

interface LinkButtonProps extends Omit<LinkProps, 'children' | 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
}

export function LinkButton({ variant = 'primary', size = 'md', className, children, ...props }: LinkButtonProps) {
  const cls = [
    styles.button,
    styles[variant],
    styles[`size-${size}`],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Link className={cls} {...(props as LinkProps)}>
      {children}
    </Link>
  );
}
