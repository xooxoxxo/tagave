/**
 * Your settings › DJ, each person's own part: Simple mode, the player
 * mixing one track into the next by itself (vault "tagave - DJ Module").
 * Kept with the person (user_prefs, hooks/useDj.ts), so it follows them
 * between devices; the device that plays applies it. One group of single
 * choices, each saved when changed, its outcome in the group's head. An
 * iOS home-screen app can't mix (a running audio graph stops the music in
 * the background), so the group says so as a value and nothing else.
 */
import { DJ_LENGTH_MAX_SEC, DJ_LENGTH_MIN_SEC, type DjCrossfade, type DjSimpleSettings } from '@tagave/shared';
import { SaveStatus, SegmentedControl, Select, SettingsGroup, SettingsRow, useSaveFlash, type SaveState } from '../components/ui';
import { useDjAvailableHere, useDjSettings } from '../hooks/useDj';
import styles from './SettingsDjPage.module.css';

const CROSSFADE: Array<{ value: DjCrossfade; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'auto', label: 'Auto' },
];

const ON_OFF = [{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }];

const LENGTHS = Array.from({ length: DJ_LENGTH_MAX_SEC - DJ_LENGTH_MIN_SEC + 1 }, (_, i) => DJ_LENGTH_MIN_SEC + i);

export interface SettingsDjViewProps {
  /** false in an iOS home-screen app */
  availableHere: boolean;
  settings: DjSimpleSettings;
  onChange: (patch: Partial<DjSimpleSettings>) => void;
  /** the last change's save */
  state?: SaveState;
  detail?: string | null;
}

/** The person's Simple mode, connected (their user_prefs, this browser's copy). */
export function SettingsDjContent() {
  const here = useDjAvailableHere();
  const flash = useSaveFlash();
  const [s, update] = useDjSettings((ok) => (ok ? flash.saved() : flash.failed()));
  return <SettingsDjView availableHere={here} settings={s} onChange={update} state={flash.state} detail={flash.detail} />;
}

/** The group alone, driven by props (stories, tests). */
export function SettingsDjView({ availableHere, settings: s, onChange: update, state = null, detail = null }: SettingsDjViewProps) {
  if (!availableHere) {
    return (
      <SettingsGroup title="DJ">
        <SettingsRow as="div" label="Simple mode" value={<span className={styles.value}>Not on this device</span>} />
      </SettingsGroup>
    );
  }
  const fixed = s.crossfade === 'fixed';
  return (
    <SettingsGroup title="DJ" status={<SaveStatus state={state} detail={detail} />}>
      <SettingsRow as="div" label="Crossfade">
        <SegmentedControl label="Crossfade" value={s.crossfade} onChange={(crossfade) => update({ crossfade })} options={CROSSFADE} />
      </SettingsRow>
      <SettingsRow label="Length" help="Used with a fixed crossfade">
        <Select dense value={String(s.lengthSec)} disabled={!fixed} onChange={(e) => update({ lengthSec: Number(e.currentTarget.value) })}>
          {LENGTHS.map((n) => <option key={n} value={n}>{n} s</option>)}
        </Select>
      </SettingsRow>
      <SettingsRow as="div" label="Beat-aligned">
        <SegmentedControl label="Beat-aligned" value={s.beatAligned ? 'on' : 'off'} onChange={(v) => update({ beatAligned: v === 'on' })} options={ON_OFF} />
      </SettingsRow>
      <SettingsRow as="div" label="Gapless albums">
        <SegmentedControl label="Gapless albums" value={s.gaplessAlbums ? 'on' : 'off'} onChange={(v) => update({ gaplessAlbums: v === 'on' })} options={ON_OFF} />
      </SettingsRow>
    </SettingsGroup>
  );
}
