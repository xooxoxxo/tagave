/**
 * Direction A, "Settings rows": one grouped list per kind. Each setting is a
 * row with its label on the left and one compact select on the right (the
 * same width everywhere); changes save on their own. The kind's backups sit
 * in a list right under its settings: date · version · size · ⋯.
 */
import type { ReactNode } from 'react';
import type { BackupKindView } from '@tagave/shared';
import { Button, Menu, Select, Surface } from '../../components/ui';
import { formatBytes } from '../../utils/format';
import { shortDate } from '../../utils/time';
import { backups as allBackups, hourLabel, KIND_LABEL, ladder, settings, versionText, versionTitle, type PreviewBackup } from './fixture';
import styles from './DirectionA.module.css';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      {children}
    </label>
  );
}

function BackupRow({ b }: { b: PreviewBackup }) {
  return (
    <li className={styles.item}>
      <span className={styles.date}>{shortDate(b.createdAt)}</span>
      <span className={styles.meta}>
        <span className={styles.version} title={versionTitle(b)}>
          {versionText(b)}
          {b.toVersion && <span className={styles.to}> → {b.toVersion}</span>}
        </span>
        <span className={styles.size}>{formatBytes(b.bytes)}</span>
      </span>
      <Menu
        size="sm"
        label={`More for the backup of ${shortDate(b.createdAt)}`}
        items={[
          { key: 'download', label: 'Download', href: '#' },
          { key: 'restore', label: 'Restore…' },
          { key: 'delete', label: 'Delete', tone: 'danger', separated: true },
        ]}
      />
    </li>
  );
}

function Group({ kind, saved, children }: { kind: BackupKindView; saved?: boolean; children?: ReactNode }) {
  const list = allBackups.filter((b) => b.kind === kind);
  const bytes = list.reduce((s, b) => s + b.bytes, 0);
  return (
    <section className={styles.group} aria-label={KIND_LABEL[kind]}>
      <div className={styles.groupHead}>
        <h3 className={styles.groupTitle}>{KIND_LABEL[kind]}</h3>
        {saved && <span className={styles.saved}>✓ Saved</span>}
        <span className={styles.groupMeta}>{list.length} · {formatBytes(bytes)}</span>
      </div>
      {children && <Surface padded={false} className={styles.list}>{children}</Surface>}
      {list.length > 0 && (
        <Surface padded={false} className={styles.list}>
          <ul className={styles.items}>{list.map((b) => <BackupRow key={b.name} b={b} />)}</ul>
        </Surface>
      )}
    </section>
  );
}

export function DirectionA() {
  const total = allBackups.reduce((s, b) => s + b.bytes, 0);
  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <span className={styles.muted}>{allBackups.length} · {formatBytes(total)}</span>
        <Button size="sm">Back up now</Button>
      </div>

      <Group kind="nightly" saved>
        <Row label="Time">
          <Select dense className={styles.control} defaultValue={settings.enabled ? settings.hour : 'off'}>
            <option value="off">Off</option>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </Select>
        </Row>
        <Row label="Daily">
          <Select dense className={styles.control} defaultValue={settings.keepDaily}>
            {ladder([1, 2, 3, 5, 7, 10, 14, 30, 60, 90], settings.keepDaily).map((n) => <option key={n} value={n}>{n} {n === 1 ? 'day' : 'days'}</option>)}
          </Select>
        </Row>
        <Row label="Weekly">
          <Select dense className={styles.control} defaultValue={settings.keepWeekly}>
            {ladder([0, 1, 2, 4, 8, 12, 26, 52], settings.keepWeekly).map((n) => <option key={n} value={n}>{n === 0 ? 'None' : `${n} ${n === 1 ? 'week' : 'weeks'}`}</option>)}
          </Select>
        </Row>
      </Group>

      <Group kind="pre-migration">
        <Row label="Keep">
          <Select dense className={styles.control} defaultValue={settings.keepPreUpdate}>
            {ladder([1, 2, 3, 5, 10, 20, 50], settings.keepPreUpdate).map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </Row>
      </Group>

      <Group kind="manual">
        <Row label="Keep">
          <Select dense className={styles.control} defaultValue={settings.keepManual ?? 'all'}>
            <option value="all">All</option>
            {ladder([1, 2, 3, 5, 10, 20, 50, 100], settings.keepManual).map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </Row>
      </Group>

      <p className={styles.muted}><code>/backups</code> · <a href="#">How to restore</a></p>
    </div>
  );
}
