/**
 * Design-direction previews for Settings › Backups (rr38, phase 1). Not wired
 * to the API: the version fields here are what phase 2 adds to
 * BackupEntryView (`version`, `versionInferred`, `toVersion`).
 */
import type { BackupKindView, BackupSettingsView } from '@tagave/shared';

export interface PreviewBackup {
  name: string;
  kind: BackupKindView;
  createdAt: string;
  bytes: number;
  /** The tagave version whose database is in the dump; null when unknown. */
  version: string | null;
  /** True when the version comes from the update history, not the sidecar. */
  versionInferred: boolean;
  /** Before update: the version it was updating to. */
  toVersion?: string;
}

const MB = 1024 ** 2;
const b = (createdAt: string, kind: BackupKindView, mb: number, version: string | null, versionInferred = false, toVersion?: string): PreviewBackup => ({
  name: `tagave-${createdAt.replace(/:/g, '-').replace('.000Z', 'Z')}${kind === 'manual' ? '' : `-${kind}`}.pgdump`,
  kind, createdAt, bytes: Math.round(mb * MB), version, versionInferred, ...(toVersion ? { toVersion } : {}),
});

// 03:00 in Amsterdam (CEST) is 01:00 UTC
export const backups: PreviewBackup[] = [
  b('2026-10-20T01:00:00.000Z', 'nightly', 694, '0.11.0'),
  b('2026-10-19T01:00:00.000Z', 'nightly', 692, '0.11.0'),
  b('2026-10-18T01:00:00.000Z', 'nightly', 690, '0.11.0'),
  b('2026-10-17T01:00:00.000Z', 'nightly', 688, '0.11.0'),
  b('2026-10-16T16:40:00.000Z', 'pre-migration', 686, '0.10.0', false, '0.11.0'),
  b('2026-10-15T12:12:00.000Z', 'manual', 684, '0.10.0'),
  b('2026-10-12T01:00:00.000Z', 'nightly', 671, '0.10.0', true),
  b('2026-10-05T01:00:00.000Z', 'nightly', 655, '0.10.0', true),
  b('2026-10-02T07:10:00.000Z', 'pre-migration', 648, '0.9.0', false, '0.10.0'),
  b('2026-09-28T01:00:00.000Z', 'nightly', 631, '0.9.0', true),
  b('2026-09-14T17:30:00.000Z', 'manual', 598, null, true),
];

export const settings: BackupSettingsView = { enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4, keepPreUpdate: 5, keepManual: null };

export const KIND_LABEL: Record<BackupKindView, string> = {
  nightly: 'Nightly',
  'pre-migration': 'Before update',
  manual: 'Manual',
  'pre-restore': 'Before restore',
};

/** "0.11.0", "~0.10.0" (inferred) or "—". */
export function versionText(x: PreviewBackup): string {
  if (!x.version) return '—';
  return `${x.versionInferred ? '~' : ''}${x.version}`;
}

export const versionTitle = (x: PreviewBackup): string | undefined =>
  !x.version ? 'Version unknown' : x.versionInferred ? 'From the update history' : undefined;

export const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** Choices for the count selects: a short ladder plus the saved value. */
export function ladder(values: number[], current: number | null): number[] {
  const set = new Set(values);
  if (current !== null) set.add(current);
  return [...set].sort((a, z) => a - z);
}
