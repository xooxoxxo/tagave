/**
 * Settings › Modules › DJ, each person's own part: Simple mode, the player
 * mixing one track into the next by itself (vault "tagave - DJ Module").
 * Kept in this browser (player/djSettings.ts); the device that plays applies
 * its own. An iOS home-screen app can't mix (a running audio graph stops the
 * music in the background), so the page says so and nothing else.
 */
import { DJ_LENGTH_MAX_SEC, DJ_LENGTH_MIN_SEC, type DjCrossfade } from '@tagave/shared';
import { SegmentedControl, Select } from '../components/ui';
import { useDjAvailableHere, useDjSettings } from '../hooks/useDj';
import styles from './SettingsDjPage.module.css';

const CROSSFADE: Array<{ value: DjCrossfade; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'auto', label: 'Auto' },
];

const ON_OFF = [{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }];

const LENGTHS = Array.from({ length: DJ_LENGTH_MAX_SEC - DJ_LENGTH_MIN_SEC + 1 }, (_, i) => DJ_LENGTH_MIN_SEC + i);

function OffOn({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel} aria-hidden="true">{label}</span>
      <SegmentedControl label={label} value={on ? 'on' : 'off'} onChange={(v) => onChange(v === 'on')} options={ON_OFF} />
    </div>
  );
}

export interface SettingsDjViewProps {
  /** false in an iOS home-screen app */
  availableHere: boolean;
}

export function SettingsDjContent({ availableHere }: Partial<SettingsDjViewProps> = {}) {
  const here = useDjAvailableHere();
  const [s, update] = useDjSettings();
  if (!(availableHere ?? here)) {
    return (
      <div className={styles.field}>
        <span className={styles.fieldLabel}>Simple mode</span>
        <span className={styles.value}>Not on this device</span>
      </div>
    );
  }
  const fixed = s.crossfade === 'fixed';
  return (
    <div className={styles.page}>
      <div className={styles.field}>
        <span className={styles.fieldLabel} aria-hidden="true">Crossfade</span>
        <SegmentedControl label="Crossfade" value={s.crossfade} onChange={(crossfade) => update({ crossfade })} options={CROSSFADE} />
      </div>
      <label className={styles.field} data-dim={fixed ? undefined : ''}>
        <span className={styles.fieldLabel}>Length</span>
        <Select dense value={String(s.lengthSec)} disabled={!fixed} onChange={(e) => update({ lengthSec: Number(e.currentTarget.value) })}>
          {LENGTHS.map((n) => <option key={n} value={n}>{n} s</option>)}
        </Select>
      </label>
      <OffOn label="Beat-aligned" on={s.beatAligned} onChange={(beatAligned) => update({ beatAligned })} />
      <OffOn label="Gapless albums" on={s.gaplessAlbums} onChange={(gaplessAlbums) => update({ gaplessAlbums })} />
    </div>
  );
}
