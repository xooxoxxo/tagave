import { Link, LinkProps } from '@tanstack/react-router';
import { ReactNode } from 'react';
import { buttonClassName, buttonLabelClassName, type ButtonVariant, type ButtonSize } from './Button';

interface LinkButtonProps extends Omit<LinkProps, 'children' | 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon-only circle; pass an aria-label. */
  icon?: boolean;
  className?: string;
  /** hover text, as on Button */
  title?: string;
  'aria-label'?: string;
  children: ReactNode;
}

/** Navigation that looks like a button. Never put a link inside a Button. */
export function LinkButton({ variant = 'primary', size = 'md', icon = false, className, title, children, ...props }: LinkButtonProps) {
  return (
    <Link className={buttonClassName({ variant, size, icon, className })} title={title} {...(props as LinkProps)}>
      <span className={buttonLabelClassName}>{children}</span>
    </Link>
  );
}
