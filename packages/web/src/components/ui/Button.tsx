import { ButtonHTMLAttributes, forwardRef, ReactNode } from 'react';
import styles from './Button.module.css';

/**
 * `ghost` is the old name for `quiet` and renders identically.
 * `quiet-danger` is the resting look of a destructive trigger (Delete, Stop):
 * danger-coloured text, no fill. `danger` is the full red drop, kept for the
 * final button of a confirm dialog.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'quiet-danger' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon-only circle. Give it an accessible name (aria-label) or use IconButton. */
  icon?: boolean;
  children: ReactNode;
  /** Keeps the width and colour, shows a spinner, sets aria-busy and blocks repeat presses. */
  loading?: boolean;
}

/** Class list shared by Button, IconButton and LinkButton. */
export function buttonClassName({ variant = 'primary', size = 'md', icon = false, className }: { variant?: ButtonVariant | undefined; size?: ButtonSize | undefined; icon?: boolean | undefined; className?: string | undefined }): string {
  return [styles.button, styles[variant], styles[`size-${size}`], icon ? styles.icon : undefined, className].filter(Boolean).join(' ');
}

export const buttonLabelClassName = styles.label;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', icon = false, type = 'button', loading = false, disabled, className, children, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={buttonClassName({ variant, size, icon, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      <span className={styles.label}>{children}</span>
      {loading && <span className={styles.spinner} aria-hidden="true" />}
    </button>
  )
);

Button.displayName = 'Button';

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'aria-label'> {
  /** Accessible name, also shown as the native tooltip unless `title` is given. */
  label: string;
}

/** A circular drop holding only an icon. Defaults to the clear secondary bubble. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, variant = 'secondary', title, children, ...props }, ref) => (
    <Button ref={ref} variant={variant} icon aria-label={label} title={title ?? label} {...props}>
      {children}
    </Button>
  )
);

IconButton.displayName = 'IconButton';
