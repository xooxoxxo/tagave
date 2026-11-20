/**
 * Settings' search field (spec §3): it filters the section list over a
 * static index of labels (pages/settingsIndex.ts). A pure view: the page
 * holds the query. Escape clears it. No "/" shortcut: that one is the
 * sidebar's search.
 */
import { SearchField } from '../ui';
import styles from './SectionNav.module.css';

export interface SettingsSearchProps {
  value: string;
  onChange: (value: string) => void;
}

export function SettingsSearch({ value, onChange }: SettingsSearchProps) {
  return (
    <SearchField
      dense
      className={styles.search}
      label="Search settings"
      placeholder="Search settings"
      slashShortcut={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.preventDefault(); onChange(''); } }}
    />
  );
}
