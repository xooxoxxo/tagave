/**
 * Direction B, "Schedule + list": the settings collapse into a read-only
 * summary with one Edit button that opens a sheet holding every control;
 * below it, one table of all backups (Date, Kind, Version, Size, ⋯) with
 * filter chips by kind.
 */
import { useState, type ReactNode } from 'react';
import type { BackupKindView } from '@tagave/shared';
import { Badge, Button, Chip, Menu, Select, Surface, Table, Td, Th, type BadgeTone } from '../../components/ui';
import { Sheet } from '../../components/ui/Sheet';
import { formatBytes } from '../../utils/format';
import { shortDate } from '../../utils/time';
import { backups as allBackups, hourLabel, KIND_LABEL, ladder, settings, versionText, versionTitle } from './fixture';
import styles from './DirectionB.module.css';

const TONE: Record<BackupKindView, BadgeTone> = { nightly: 'neutral', manual: 'info', 'pre-migration': 'accent', 'pre-restore': 'warning' };
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.summaryRow}>
      <span className={styles.summaryLabel}>{label}</span>
      <span className={styles.summaryValue}>{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function EditSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const phone = typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Backup schedule" side={phone ? 'bottom' : 'right'} className={styles.sheet}>
      <div className={styles.sheetBody}>
        <h3 className={styles.sheetTitle}>Schedule</h3>
        <div>
          <h4 className={styles.groupTitle}>Nightly</h4>
          <Surface padded={false} variant="inset" className={styles.fields}>
            <Field label="Time">
              <Select dense className={styles.control} defaultValue={settings.hour}>
                <option value="off">Off</option>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </Select>
            </Field>
            <Field label="Daily">
              <Select dense className={styles.control} defaultValue={settings.keepDaily}>
                {ladder([1, 2, 3, 5, 7, 10, 14, 30, 60, 90], settings.keepDaily).map((n) => <option key={n} value={n}>{plural(n, 'day')}</option>)}
              </Select>
            </Field>
            <Field label="Weekly">
              <Select dense className={styles.control} defaultValue={settings.keepWeekly}>
                {ladder([0, 1, 2, 4, 8, 12, 26, 52], settings.keepWeekly).map((n) => <option key={n} value={n}>{n === 0 ? 'None' : plural(n, 'week')}</option>)}
              </Select>
            </Field>
          </Surface>
        </div>
        <div>
          <h4 className={styles.groupTitle}>Before update</h4>
          <Surface padded={false} variant="inset" className={styles.fields}>
            <Field label="Keep">
              <Select dense className={styles.control} defaultValue={settings.keepPreUpdate}>
                {ladder([1, 2, 3, 5, 10, 20, 50], settings.keepPreUpdate).map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
          </Surface>
        </div>
        <div>
          <h4 className={styles.groupTitle}>Manual</h4>
          <Surface padded={false} variant="inset" className={styles.fields}>
            <Field label="Keep">
              <Select dense className={styles.control} defaultValue="all">
                <option value="all">All</option>
                {ladder([1, 2, 3, 5, 10, 20, 50, 100], null).map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
          </Surface>
        </div>
        <div className={styles.sheetActions}>
          <Button variant="quiet" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => onOpenChange(false)}>Save</Button>
        </div>
      </div>
    </Sheet>
  );
}

export function DirectionB({ editing = false }: { editing?: boolean }) {
  const [open, setOpen] = useState(editing);
  const [filter, setFilter] = useState<BackupKindView | 'all'>('all');
  const kinds: BackupKindView[] = ['nightly', 'pre-migration', 'manual'];
  const shown = filter === 'all' ? allBackups : allBackups.filter((b) => b.kind === filter);
  const total = allBackups.reduce((s, b) => s + b.bytes, 0);
  const s = settings;
  return (
    <div className={styles.page}>
      <section className={styles.section} aria-label="Schedule">
        <div className={styles.head}>
          <h3 className={styles.groupTitle}>Schedule</h3>
          <Button variant="quiet" size="sm" onClick={() => setOpen(true)}>Edit</Button>
        </div>
        <Surface padded={false} className={styles.summary}>
          <SummaryRow label="Nightly" value={s.enabled ? `${hourLabel(s.hour)} · ${plural(s.keepDaily, 'day')} · ${plural(s.keepWeekly, 'week')}` : 'Off'} />
          <SummaryRow label="Before update" value={`Keep ${s.keepPreUpdate}`} />
          <SummaryRow label="Manual" value={s.keepManual === null ? 'Keep all' : `Keep ${s.keepManual}`} />
        </Surface>
      </section>

      <section className={styles.section} aria-label="Backups">
        <div className={styles.head}>
          <div className={styles.chips} role="group" aria-label="Show">
            <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All {allBackups.length}</Chip>
            {kinds.map((k) => (
              <Chip key={k} active={filter === k} onClick={() => setFilter(k)}>
                {KIND_LABEL[k]} {allBackups.filter((b) => b.kind === k).length}
              </Chip>
            ))}
          </div>
          <Button size="sm">Back up now</Button>
        </div>
        <Table className={styles.table}>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th className={styles.kindCol}>Kind</Th>
              <Th>Version</Th>
              <Th className={`${styles.num} ${styles.sizeCol}`}>Size</Th>
              <Th><span className="visually-hidden">Actions</span></Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((b) => (
              <tr key={b.name}>
                <Td>
                  <span className={styles.date}>{shortDate(b.createdAt)}</span>
                  <span className={styles.sub}>{KIND_LABEL[b.kind]} · {formatBytes(b.bytes)}</span>
                </Td>
                <Td className={styles.kindCol}><Badge tone={TONE[b.kind]}>{KIND_LABEL[b.kind]}</Badge></Td>
                <Td className={styles.version}>
                  <span title={versionTitle(b)}>{versionText(b)}</span>
                  {b.toVersion && <span className={styles.to}> → {b.toVersion}</span>}
                </Td>
                <Td className={`${styles.num} ${styles.sizeCol}`}>{formatBytes(b.bytes)}</Td>
                <Td className={styles.menuCell}>
                  <Menu
                    size="sm"
                    label={`More for the backup of ${shortDate(b.createdAt)}`}
                    items={[
                      { key: 'download', label: 'Download', href: '#' },
                      { key: 'restore', label: 'Restore…' },
                      { key: 'delete', label: 'Delete', tone: 'danger', separated: true },
                    ]}
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className={styles.muted}>{allBackups.length} · {formatBytes(total)} · <code>/backups</code> · <a href="#">How to restore</a></p>
      </section>
      <EditSheet open={open} onOpenChange={setOpen} />
    </div>
  );
}
