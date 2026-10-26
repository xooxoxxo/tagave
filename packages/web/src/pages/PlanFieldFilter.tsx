import { useId, useState } from 'react';
import { CloseIcon, Collapse } from '../components/ui';
import styles from './PlanPage.module.css';

export interface FieldFilterEntry {
  field: string;
  /** plain name, e.g. "Album title" */
  label: string;
  files: number;
  /** "overwrite/fill" */
  reasonShort: string;
  /** "120 overwrite · 12 fill", for the tooltip */
  reasonTitle: string;
}

/**
 * Narrow the file list to one field. Collapsed by default to a single line:
 * the counts already show in the list below, so the tiles are only for
 * picking. The line keeps one fixed height whether or not a field is picked;
 * the picked field and its clear button sit inside it, never under it.
 */
export function PlanFieldFilter({ entries, field, onPick, defaultOpen = false }: {
  entries: FieldFilterEntry[];
  /** the picked field, '' for all */
  field: string;
  onPick: (field: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const picked = field ? entries.find((e) => e.field === field) : undefined;
  const pickedLabel = picked?.label ?? field;
  return (
    <section className={styles.fieldFilter} aria-label="Filter by field">
      <div className={styles.fieldHead} data-field-filter-head>
        <button
          type="button"
          className={styles.fieldToggle}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
        >
          <span className={`${styles.fieldCaret} ${open ? styles.fieldCaretOpen : ''}`} aria-hidden="true">▸</span>
          <span>Filter by field</span>
          <span className={styles.fieldMeta}>· {entries.length.toLocaleString()} {entries.length === 1 ? 'field' : 'fields'}</span>
        </button>
        {field && (
          <span className={styles.fieldPicked}>
            <span className={styles.fieldPickedLabel} title={pickedLabel}>{pickedLabel}</span>
            <button
              type="button"
              className={styles.fieldClear}
              onClick={() => onPick('')}
              aria-label={`Clear the field filter (${pickedLabel}); show all fields`}
              title="Show all fields"
            >
              <CloseIcon />
            </button>
          </span>
        )}
      </div>
      <Collapse open={open} id={panelId}>
        <div className={styles.chips}>
          {entries.map((e) => (
            <button
              key={e.field}
              type="button"
              className={`${styles.chip} ${field === e.field ? styles.chipActive : ''}`}
              onClick={() => onPick(field === e.field ? '' : e.field)}
              title={e.reasonTitle}
              aria-label={`Filter files by ${e.label}`}
              aria-pressed={field === e.field}
            >
              <span className={styles.chipField}>{e.label}</span>
              <span className={styles.chipReason}>{e.reasonShort}</span>
              <span className={styles.chipCount}>{e.files.toLocaleString()}</span>
            </button>
          ))}
        </div>
      </Collapse>
    </section>
  );
}
