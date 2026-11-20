/**
 * Maintenance in Library care's header (spec §4): a label and Off/On. The
 * curation tools (match state, provider links, library issues, the Manage
 * menu) show only while it is on. Shift+M and the album page's wrench switch
 * the same state.
 */
import { SegmentedControl } from './ui';
import { useMaintenance } from '../maintenance';
import styles from './MaintenanceControl.module.css';

const OPTIONS = [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] as const;

export function MaintenanceControlView({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={styles.control}>
      <span className={styles.label} aria-hidden="true">Maintenance</span>
      <SegmentedControl label="Maintenance" size="sm" value={on ? 'on' : 'off'} onChange={(v) => onChange(v === 'on')} options={[...OPTIONS]} />
    </div>
  );
}

export function MaintenanceControl() {
  const [on, setOn] = useMaintenance();
  return <MaintenanceControlView on={on} onChange={setOn} />;
}
