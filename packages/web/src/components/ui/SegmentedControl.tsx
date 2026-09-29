import { useId, type ReactNode } from 'react';
import { useThemePreference, type ThemePreference } from '../../theme';
import styles from './SegmentedControl.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  /** Accessible group name. */
  label: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  name?: string;
}

/**
 * One choice out of a few, as native radio buttons in a pill track, so arrow
 * keys, form semantics and screen readers work without custom key handling.
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange, name }: SegmentedControlProps<T>) {
  const generated = useId();
  const groupName = name ?? generated;
  return <div role="radiogroup" aria-label={label} className={styles.track}>
    {options.map(option => <label key={option.value} className={[styles.option, option.value === value ? styles.selected : undefined].filter(Boolean).join(' ')}>
      <input className={styles.radio} type="radio" name={groupName} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} />
      <span>{option.label}</span>
    </label>)}
  </div>;
}

const themeOptions: SegmentedOption<ThemePreference>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Light, dark, or follow the operating system (the default). */
export function ThemeSwitch() {
  const [preference, setPreference] = useThemePreference();
  return <SegmentedControl label="Colour theme" options={themeOptions} value={preference} onChange={setPreference} />;
}
