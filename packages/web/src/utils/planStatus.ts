import { statusTone, type BadgeTone } from '../components/ui/Badge';

/**
 * The status a plan shows. The worker parks a finished apply with any failed
 * file as partially_failed; when not one file was written that reads as
 * "failed", which is what it is.
 */
export function planStatusView(
  status: string,
  progress?: Record<string, number | undefined> | null,
): { label: string; tone: BadgeTone; allFailed: boolean } {
  const applied = progress?.['applied'] ?? 0;
  const failed = progress?.['failed'] ?? 0;
  if (status === 'partially_failed' && progress && applied === 0 && failed > 0) {
    return { label: 'failed', tone: 'danger', allFailed: true };
  }
  return { label: status.replaceAll('_', ' '), tone: statusTone(status), allFailed: false };
}

/** Extensions whose tags are ID3 frames: only these care about the ID3 version. */
const ID3_FORMATS = new Set(['mp3', 'wav', 'aif', 'aiff', 'dsf', 'dff']);

export function planUsesId3(formats: readonly string[] | undefined): boolean {
  return (formats ?? []).some((f) => ID3_FORMATS.has(f.toLowerCase()));
}

type DiffValue = string | string[] | null | undefined;

const blank = (v: DiffValue) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/**
 * What one diff row does, in words: a value where the file had none is an
 * "add" whatever the policy that chose it, not a change from "".
 */
export function diffRowKind(d: { before: DiffValue; after: DiffValue; reason: string }): string {
  if (d.reason === 'locked') return 'locked';
  if (d.reason === 'revert') return 'revert';
  if (blank(d.before) && !blank(d.after)) return 'add';
  return d.reason.replace('policy:', '');
}

/** A diff cell: nothing (missing or blank) shows as a dash. */
export function diffValueText(v: DiffValue): string {
  if (blank(v)) return '—';
  return Array.isArray(v) ? v.join('; ') : (v as string);
}
