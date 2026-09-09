import { forwardRef, useId, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';
import styles from './FormControl.module.css';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={[styles.control, className].filter(Boolean).join(' ')} {...props} />
));
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={[styles.control, className].filter(Boolean).join(' ')} {...props} />
));
Select.displayName = 'Select';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={[styles.control, styles.textarea, className].filter(Boolean).join(' ')} {...props} />
));
Textarea.displayName = 'Textarea';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

/** Visible label and supporting text stay connected to the input, including validation errors. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(({ label, hint, error, id, 'aria-describedby': describedBy, ...props }, ref) => {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const messageId = `${inputId}-message`;
  const message = error || hint;
  return <div className={styles.field}>
    <label className={styles.label} htmlFor={inputId}>{label}{props.required && <span aria-hidden="true"> *</span>}</label>
    <Input {...props} ref={ref} id={inputId} aria-invalid={error ? true : props['aria-invalid']} aria-describedby={[describedBy, message ? messageId : undefined].filter(Boolean).join(' ') || undefined} />
    {message && <p id={messageId} className={error ? styles.error : styles.hint}>{message}</p>}
  </div>;
});
TextField.displayName = 'TextField';
