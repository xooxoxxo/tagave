/**
 * One tag plan, full page: what it covers, what it would change (per-file
 * diff table), and the buttons for its current state — run the preview,
 * apply, pause, resume, cancel, revert. Reached from the plans list and from
 * the wizard the moment a plan is created; the same page serves plans made
 * earlier. Nothing is written until Apply.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import type { TagDiffEntry } from '@liner/shared';
import { useCurrentLibrary } from '../hooks';
import { useLibrarySettings, useScanRoots } from '../hooks/useLibrary';
import {
  useApplyTagPlan,
  useCancelTagPlan,
  usePauseTagPlan,
  usePreviewTagPlan,
  useResumeTagPlan,
  useRevertTagPlan,
  useTagPlan,
  useTagPlanItems,
} from '../hooks/usePlanWizard';
import { formatDateTime, formatRelativeTime } from '../utils';
import styles from './PlanPage.module.css';

const PAGE_SIZE = 100;
const BUSY = new Set(['applying', 'paused']);

function fmtValue(v: string | string[] | null): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.join('; ');
  return v === '' ? '(empty)' : v;
}

const PRESET_LABEL: Record<string, string> = {
  canonical_ids_and_fill: 'Canonical IDs + fill',
  fill_blanks_only: 'Fill blanks only',
  overwrite_all: 'Overwrite all',
  custom: 'Custom',
};

function scopeLabel(scope: Record<string, unknown> | undefined): string {
  const type = scope?.type as string | undefined;
  switch (type) {
    case 'library': return 'Entire library';
    case 'artist': return 'All albums by one artist';
    case 'albumIds': return `${(scope?.albumIds as string[] | undefined)?.length ?? 0} album(s)`;
    case 'filterQuery': return 'Albums matching a filter';
    default: return '—';
  }
}

export function PlanPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  const { libraryId } = useCurrentLibrary();
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState('');
  const [offset, setOffset] = useState(0);
  const [pathFilter, setPathFilter] = useState('');
  const [previewRequested, setPreviewRequested] = useState(false);

  const plan = useTagPlan(libraryId, planId, { refetchInterval: 0 });
  const status = plan.data?.status;
  // Poll while a worker is on it: preview running, applying, paused.
  const polling = previewRequested || (status !== undefined && BUSY.has(status));
  const livePlan = useTagPlan(libraryId, planId, { refetchInterval: polling ? 2000 : false });
  const p = livePlan.data ?? plan.data;

  const settings = useLibrarySettings(libraryId);
  const roots = useScanRoots(libraryId);
  const previewM = usePreviewTagPlan(libraryId, planId);
  const applyM = useApplyTagPlan(libraryId, planId);
  const pauseM = usePauseTagPlan(libraryId, planId);
  const resumeM = useResumeTagPlan(libraryId, planId);
  const cancelM = useCancelTagPlan(libraryId, planId);
  const revertM = useRevertTagPlan(libraryId, planId);

  const previewed = !!p && p.status !== 'draft';
  const items = useTagPlanItems(libraryId, planId, { ...(field ? { fieldFilter: field } : {}), limit: PAGE_SIZE, offset, enabled: previewed });

  // A freshly created plan (or one reverted to draft) previews itself once.
  useEffect(() => {
    if (!previewRequested && p?.status === 'draft' && !previewM.isPending) {
      setPreviewRequested(true);
      previewM.mutateAsync().catch((e: Error) => setError(e.message));
    }
    if (previewRequested && p && p.status !== 'draft') setPreviewRequested(false);
  }, [previewRequested, p, previewM]);

  const stats = p?.stats;
  const progress = p?.progress;
  const tagWritesDisabled = settings.data !== undefined && !settings.data.tagWritesEnabled;
  const noWritableRoots = roots.data !== undefined && !roots.data.some((r) => r.writable);
  const nothingToDo = previewed && stats !== undefined && stats.filesTouched === 0;
  const canApply = p?.status === 'previewed' && !nothingToDo && !tagWritesDisabled && !noWritableRoots;
  const applyTitle = !previewed ? 'Preview has not finished yet'
    : nothingToDo ? 'Nothing to change'
      : tagWritesDisabled ? 'Tag writes are off in Settings › Tag writes'
        : noWritableRoots ? 'No scan root allows writes (Settings › Scan roots)'
          : p?.status !== 'previewed' ? `Plan is ${p?.status}` : undefined;

  const run = (m: { mutateAsync: () => Promise<unknown> }, confirmText?: string) => async () => {
    if (confirmText && !window.confirm(confirmText)) return;
    setError(null);
    try {
      await m.mutateAsync();
    } catch (e) {
      setError((e as { detail?: string; message?: string })?.detail ?? (e as Error).message);
    }
  };

  const fields = useMemo(() => {
    const s = new Set<string>();
    for (const it of items.data?.items ?? []) for (const d of it.diffs) s.add(d.field);
    return [...s].sort();
  }, [items.data]);
  const visibleItems = (items.data?.items ?? []).filter((it) => !pathFilter || (it.relPath ?? '').toLowerCase().includes(pathFilter.toLowerCase()));
  const total = items.data?.total ?? 0;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);
  const done = (progress?.applied ?? 0) + (progress?.failed ?? 0) + (progress?.skipped ?? 0);
  const pct = progress && progress.total > 0 ? Math.round((done / progress.total) * 100) : 0;

  if (!libraryId || plan.isLoading) return <div className={styles.page}>Loading plan…</div>;
  if (plan.isError || !p) {
    return (
      <div className={styles.page}>
        <Link to="/plans" className={styles.back}>← Plans</Link>
        <p className={styles.error}>This plan could not be loaded.</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.topbar}>
        <Link to="/plans" className={styles.back}>← Plans</Link>
        <span className={`${styles.badge} ${styles[`status_${p.status}`] ?? ''}`}>{p.status.replaceAll('_', ' ')}</span>
      </div>

      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{p.name || 'Untitled plan'}</h1>
          <p className={styles.meta}>
            {scopeLabel(p.scope as Record<string, unknown>)} · {PRESET_LABEL[p.policy.preset] ?? p.policy.preset} · ID3v{p.policy.id3Version}
            {' · '}created <span title={formatDateTime(p.createdAt)}>{formatRelativeTime(p.createdAt)}</span>
            {p.appliedAt && <> · applied <span title={formatDateTime(p.appliedAt)}>{formatRelativeTime(p.appliedAt)}</span></>}
          </p>
        </div>
        <div className={styles.actions}>
          {(p.status === 'previewed' || p.status === 'draft' || p.status === 'reverted' || p.status === 'cancelled') && (
            <button type="button" className={styles.btn} onClick={run(previewM)} disabled={previewM.isPending || previewRequested}>
              {previewRequested || previewM.isPending ? 'Previewing…' : previewed ? 'Re-run preview' : 'Run preview'}
            </button>
          )}
          {p.status === 'previewed' && (
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={run(applyM, `Write the previewed changes to ${stats?.filesTouched ?? 0} file(s)? Every write is journaled and can be reverted from this page.`)} disabled={!canApply || applyM.isPending} title={applyTitle}>
              {applyM.isPending ? 'Starting…' : 'Apply now'}
            </button>
          )}
          {p.status === 'applying' && (
            <>
              <button type="button" className={styles.btn} onClick={run(pauseM)} disabled={pauseM.isPending}>Pause</button>
              <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={run(cancelM, 'Stop applying? Files already written stay written; you can revert them afterwards.')} disabled={cancelM.isPending}>Cancel</button>
            </>
          )}
          {p.status === 'paused' && (
            <>
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={run(resumeM)} disabled={resumeM.isPending}>Resume</button>
              <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={run(cancelM, 'Stop applying? Files already written stay written; you can revert them afterwards.')} disabled={cancelM.isPending}>Cancel</button>
            </>
          )}
          {(p.status === 'applied' || p.status === 'partially_failed' || p.status === 'cancelled') && (progress?.applied ?? 0) > 0 && (
            <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={run(revertM, `Restore the previous tags on ${progress?.applied ?? 0} file(s)?`)} disabled={revertM.isPending}>
              {revertM.isPending ? 'Starting…' : 'Revert'}
            </button>
          )}
        </div>
      </header>

      {(tagWritesDisabled || noWritableRoots) && (
        <div className={styles.banner}>
          <strong>This plan can be previewed but not applied yet.</strong>
          <ul>
            {tagWritesDisabled && <li>Tag writes are off — <Link to="/settings/tag-writes">Settings › Tag writes</Link></li>}
            {noWritableRoots && <li>No scan root allows writes — <Link to="/settings/scan-roots">Settings › Scan roots</Link></li>}
          </ul>
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {!previewed && (
        <div className={styles.note}>
          <p>{previewRequested || previewM.isPending ? 'Computing the preview…' : 'No preview yet.'}</p>
          <p className={styles.hint}>Every file in scope is read once; a whole-library plan can take a few minutes. Nothing is written.</p>
        </div>
      )}

      {p.status === 'paused' && stats?.lastError && (
        <p className={styles.error}>The last run stopped early: {stats.lastError}. Resume retries the files that were not written.</p>
      )}

      {previewed && stats && (
        <div className={styles.summary}>
          <div className={styles.stat}><strong>{stats.filesTouched.toLocaleString()}</strong><span>files change</span></div>
          <div className={styles.stat}><strong>{stats.fieldsModified.toLocaleString()}</strong><span>field changes</span></div>
          <div className={styles.stat}><strong>{stats.lockedFieldsRespected.toLocaleString()}</strong><span>locked fields kept</span></div>
          <div className={styles.stat}><strong>{stats.filesSkipped.length.toLocaleString()}</strong><span>files skipped</span></div>
          {progress && progress.total > 0 && (p.status !== 'previewed') && (
            <div className={styles.stat}><strong>{progress.applied.toLocaleString()}</strong><span>files written{progress.failed ? ` · ${progress.failed} failed` : ''}</span></div>
          )}
        </div>
      )}

      {previewed && stats && stats.filesSkipped.length > 0 && (
        <p className={styles.hint}>
          Skipped: {Object.entries(stats.filesSkipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.message ?? s.reason]: (acc[s.message ?? s.reason] ?? 0) + 1 }), {}))
            .map(([reason, n]) => `${n} × ${reason.replaceAll('_', ' ')}`).join(', ')}
        </p>
      )}

      {progress && BUSY.has(p.status) && (
        <div className={styles.progress}>
          <div className={styles.bar}><div className={styles.fill} style={{ width: `${pct}%` }} /></div>
          <span>{done.toLocaleString()} / {progress.total.toLocaleString()} files{p.status === 'paused' ? ' · paused' : ''}</span>
        </div>
      )}

      {p.status === 'applied' && (
        <p className={styles.success}>Applied. Check a file in your player; each album's History tab shows the write and offers the same revert.</p>
      )}

      {nothingToDo && (
        <div className={styles.note}><p>Every file in scope already carries the canonical values under this policy. Nothing to apply.</p></div>
      )}

      {previewed && !nothingToDo && (
        <>
          <div className={styles.tools}>
            <label htmlFor="planField" className={styles.label}>Field</label>
            <select id="planField" className={styles.select} value={field} onChange={(e) => { setField(e.target.value); setOffset(0); }}>
              <option value="">all fields</option>
              {fields.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <input className={styles.input} type="search" placeholder="Filter this page by path…" value={pathFilter} onChange={(e) => setPathFilter(e.target.value)} />
            <span className={styles.count}>
              {items.isLoading ? 'Loading…' : total === 0 ? 'No rows' : `${offset + 1}–${pageEnd} of ${total.toLocaleString()} files`}
            </span>
            <span className={styles.pager}>
              <button type="button" className={styles.btn} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>‹</button>
              <button type="button" className={styles.btn} disabled={pageEnd >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>›</button>
            </span>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <colgroup>
                <col className={styles.colFile} /><col className={styles.colField} /><col className={styles.colValue} /><col className={styles.colValue} /><col className={styles.colWhy} />
              </colgroup>
              <thead>
                <tr><th>File</th><th>Field</th><th>Before</th><th>After</th><th>Why</th></tr>
              </thead>
              <tbody>
                {visibleItems.map((it) => {
                  const rows = (it.diffs as TagDiffEntry[]).filter((d) => d.reason !== 'no-change');
                  if (rows.length === 0) return null;
                  return rows.map((d, i) => (
                    <tr key={`${it.id}:${d.field}`} className={i === 0 ? styles.firstRow : undefined}>
                      {i === 0 && (
                        <td rowSpan={rows.length} className={styles.cellPath} title={it.relPath ?? it.audioFileId}>
                          <span className={styles.pathDir}>{(it.relPath ?? '').split('/').slice(0, -1).join('/')}</span>
                          <span className={styles.pathFile}>{(it.relPath ?? it.audioFileId).split('/').pop()}</span>
                        </td>
                      )}
                      <td className={styles.cellField}>{d.field}</td>
                      <td className={styles.cellValue}>{fmtValue(d.before)}</td>
                      <td className={styles.cellValue}>{d.reason === 'locked' ? <em>kept (locked)</em> : fmtValue(d.after)}</td>
                      <td className={styles.cellWhy}>{d.reason.replace('policy:', '')}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
