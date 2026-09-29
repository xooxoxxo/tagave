import { forwardRef, useEffect, useId, useImperativeHandle, useRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';
import styles from './FormControl.module.css';

interface DenseProp {
  /** 36px instead of 48px, for toolbars and table rows. */
  dense?: boolean;
}

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & DenseProp>(({ className, dense, ...props }, ref) => (
  <input ref={ref} className={cx(styles.control, dense && styles.dense, className)} {...props} />
));
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & DenseProp>(({ className, dense, ...props }, ref) => (
  <select ref={ref} className={cx(styles.control, styles.select, dense && styles.dense, className)} {...props} />
));
Select.displayName = 'Select';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cx(styles.control, styles.textarea, className)} {...props} />
));
Textarea.displayName = 'Textarea';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement>, DenseProp {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** The value before a pending edit; shown struck through under the field. */
  previousValue?: ReactNode;
}

/** Visible label and supporting text stay connected to the input, including validation errors. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(({ label, hint, error, previousValue, id, 'aria-describedby': describedBy, ...props }, ref) => {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const messageId = `${inputId}-message`;
  const pendingId = `${inputId}-previous`;
  const message = error || hint;
  const hasPending = previousValue !== undefined && previousValue !== null;
  return <div className={styles.field}>
    <label className={styles.label} htmlFor={inputId}>{label}{props.required && <span aria-hidden="true"> *</span>}</label>
    <Input {...props} ref={ref} id={inputId} aria-invalid={error ? true : props['aria-invalid']} aria-describedby={[describedBy, hasPending ? pendingId : undefined, message ? messageId : undefined].filter(Boolean).join(' ') || undefined} />
    {hasPending && <PendingValue id={pendingId} previous={previousValue} />}
    {message && <p id={messageId} className={error ? styles.error : styles.hint}>{message}</p>}
  </div>;
});
TextField.displayName = 'TextField';

/** "Was: old value" line with a dew dot, for fields that carry an unsaved change. */
export function PendingValue({ previous, id }: { previous: ReactNode; id?: string }) {
  return <p className={styles.pending} id={id}>
    <span className="visually-hidden">Currently </span><s>{previous === '' ? '(empty)' : previous}</s>
    <span className={styles.pendingDot} aria-hidden="true" />
  </p>;
}

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>, DenseProp {
  /** Accessible name. Search fields carry no visible label. */
  label: string;
  /** Press "/" anywhere outside a text field to focus this search. Default true. */
  slashShortcut?: boolean;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Search pill: leading magnifier, trailing "/" hint that hides once you type. */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(({ label, slashShortcut = true, dense, className, placeholder = 'Search', ...props }, ref) => {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);
  useEffect(() => {
    if (!slashShortcut) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [slashShortcut]);
  return <div className={cx(styles.search, className)}>
    <input ref={inputRef} type="search" aria-label={label} placeholder={placeholder} className={cx(styles.control, dense && styles.dense)} {...props} />
    <svg className={styles.searchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>
    {slashShortcut && <kbd className={styles.kbd} aria-hidden="true">/</kbd>}
  </div>;
});
SearchField.displayName = 'SearchField';
