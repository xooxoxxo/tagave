import { useId, useState, type ReactNode } from 'react';
import styles from './HelpToggle.module.css';

export interface HelpToggleProps {
  /** What the help is about; the button is named "Help: <label>". */
  label: string;
  children: ReactNode;
}

/**
 * A quiet `?` that shows a hint below it, so help never sits inline. Renders
 * the button and the hint as siblings: in a wrapping flex row (a settings
 * head or row) the hint takes a line of its own under the row.
 */
export function HelpToggle({ label, children }: HelpToggleProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={styles.toggle}
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">?</span>
      </button>
      <div id={id} className={styles.hint} hidden={!open}>{children}</div>
    </>
  );
}
