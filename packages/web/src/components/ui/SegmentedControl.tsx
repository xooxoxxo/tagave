import { useId, type ReactNode } from 'react';
import { useSlidingIndicator } from './useSlidingIndicator';
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
  /** 'sm' for toolbars (Grid · List); the default suits a settings pane */
  size?: 'md' | 'sm';
}

/**
 * One choice out of a few, as native radio buttons in a pill track, so arrow
 * keys, form semantics and screen readers work without custom key handling.
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange, name, size = 'md' }: SegmentedControlProps<T>) {
  const generated = useId();
  const groupName = name ?? generated;
  const { trackRef, indicatorRef } = useSlidingIndicator<HTMLDivElement>(value);
  return <div ref={trackRef} role="radiogroup" aria-label={label} className={[styles.track, size === 'sm' ? styles.small : undefined].filter(Boolean).join(' ')}>
    <span ref={indicatorRef} className={styles.indicator} aria-hidden="true" />
    {options.map(option => <label key={option.value} data-active={option.value === value} className={[styles.option, option.value === value ? styles.selected : undefined].filter(Boolean).join(' ')}>
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
