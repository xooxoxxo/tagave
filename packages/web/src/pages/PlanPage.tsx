/**
 * One tag plan, full page. Reads top-down the way a large batch has to be
 * read: what the plan is, how far it got, which fields it changes (and how
 * many files each), then one collapsed row per file that opens into the
 * per-field diff. Actions for the current state sit in the header. Nothing
 * is written until Apply.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import type { TagDiffEntry, TagPlanItem } from '@liner/shared';
import { PageShell, Button, Badge, statusTone, Banner, StatCard, Card } from '../components/ui';
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
  useTagPlanSummary,
} from '../hooks/usePlanWizard';
import { formatDateTime, formatRelativeTime } from '../utils';
import styles from './PlanPage.module.css';

const PAGE_SIZE = 100;
const BUSY = new Set(['applying', 'paused']);
/** How long the page keeps polling after an action while it waits for the worker to flip the status. */
const AWAIT_MS = 120_000;

type ItemStatus = NonNullable<TagPlanItem['status']>;
const ITEM_TONE: Record<ItemStatus, 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  pending: 'neutral', applying: 'info', applied: 'success', failed: 'danger', skipped: 'warning',
};

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

const reasonLabel = (r: string) => r.replace('policy:', '');

export function PlanPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  const { libraryId } = useCurrentLibrary();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState('');
  const [itemStatus, setItemStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [pathFilter, setPathFilter] = useState('');
  const [previewRequested, setPreviewRequested] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [allOpen, setAllOpen] = useState(false);
  // Status at the moment an action was sent; the page polls until it changes
  // (the worker flips it a few seconds after the 202), or gives up after AWAIT_MS.
  const [awaiting, setAwaiting] = useState<string | null>(null);

  const planQ = useTagPlan(libraryId, planId, { refetchInterval: 0 });
  const status = planQ.data?.status;
  const polling = previewRequested || awaiting !== null || (status !== undefined && BUSY.has(status));
  const liveQ = useTagPlan(libraryId, planId, { refetchInterval: polling ? 2000 : false });
  const p = liveQ.data ?? planQ.data;

  useEffect(() => {
    if (awaiting !== null && status !== undefined && status !== awaiting) setAwaiting(null);
  }, [awaiting, status]);
  useEffect(() => {
    if (awaiting === null) return;
    const t = setTimeout(() => setAwaiting(null), AWAIT_MS);
    return () => clearTimeout(t);
  }, [awaiting]);
  // Items and the summary change together with the plan status.
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['tag-plan-items', libraryId, planId] });
    void qc.invalidateQueries({ queryKey: ['tag-plan-summary', libraryId, planId] });
  }, [status, libraryId, planId, qc]);

  const settings = useLibrarySettings(libraryId);
  const roots = useScanRoots(libraryId);
  const previewM = usePreviewTagPlan(libraryId, planId);
  const applyM = useApplyTagPlan(libraryId, planId);
  const pauseM = usePauseTagPlan(libraryId, planId);
  const resumeM = useResumeTagPlan(libraryId, planId);
  const cancelM = useCancelTagPlan(libraryId, planId);
  const revertM = useRevertTagPlan(libraryId, planId);

  const previewed = !!p && p.status !== 'draft';
  const summary = useTagPlanSummary(libraryId, planId, { enabled: previewed, refetchInterval: polling ? 4000 : false });
  const items = useTagPlanItems(libraryId, planId, {
    ...(field ? { fieldFilter: field } : {}),
    ...(itemStatus ? { statusFilter: itemStatus } : {}),
    limit: PAGE_SIZE,
    offset,
    enabled: previewed,
    refetchInterval: polling ? 4000 : false,
  });

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
      : tagWritesDisabled ? 'Tag writes are off in Settings › Library'
        : noWritableRoots ? 'No scan root allows writes (Settings › Library)'
          : p?.status !== 'previewed' ? `Plan is ${p?.status}` : undefined;

  const run = (m: { mutateAsync: () => Promise<unknown> }, confirmText?: string) => async () => {
    if (confirmText && !window.confirm(confirmText)) return;
    setError(null);
    try {
      await m.mutateAsync();
      setAwaiting(p?.status ?? null);
    } catch (e) {
      setError((e as { detail?: string; message?: string })?.detail ?? (e as Error).message);
    }
  };

  const byField = useMemo(() => {
    const map = new Map<string, { files: number; reasons: Record<string, number> }>();
    for (const r of summary.data?.fields ?? []) {
      const cur = map.get(r.field) ?? { files: 0, reasons: {} };
      cur.files += r.files;
      cur.reasons[r.reason] = (cur.reasons[r.reason] ?? 0) + r.files;
      map.set(r.field, cur);
    }
    return [...map.entries()].sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]));
  }, [summary.data]);
  const statusCounts = summary.data?.statuses ?? {};

  const pageItems = items.data?.items ?? [];
  const visibleItems = pathFilter
    ? pageItems.filter((it) => (it.relPath ?? '').toLowerCase().includes(pathFilter.toLowerCase()))
    : pageItems;
  const total = items.data?.total ?? 0;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);
  const done = (progress?.applied ?? 0) + (progress?.failed ?? 0) + (progress?.skipped ?? 0);
  const pct = progress && progress.total > 0 ? Math.round((done / progress.total) * 100) : 0;

  const isOpen = (id: string) => (allOpen ? !expanded.has(id) : expanded.has(id));
  const toggle = (id: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => { setAllOpen((v) => !v); setExpanded(new Set()); };

  if (!libraryId || planQ.isLoading) return <PageShell title="Loading">Loading plan…</PageShell>;
  if (planQ.isError || !p) {
    return (
      <PageShell title="Plan not found">
        <div className={styles.body}>
          <Link to="/plans" className={styles.back}>← Plans</Link>
          <p className={styles.error}>This plan could not be loaded.</p>
        </div>
      </PageShell>
    );
  }

  const confirmStop = 'Stop applying? Files already written stay written; you can revert them afterwards.';

  return (
    <PageShell
      title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-md)' }}>
        {p.name || 'Untitled plan'}
        <Badge tone={statusTone(p.status)}>{p.status.replaceAll('_', ' ')}</Badge>
      </span>}
      subtitle={
        <span className={styles.meta}>
          <Link to="/plans" className={styles.back}>Plans</Link>
          {' › '}{scopeLabel(p.scope as Record<string, unknown>)} · {PRESET_LABEL[p.policy.preset] ?? p.policy.preset} · ID3v{p.policy.id3Version}
          {' · '}created <span title={formatDateTime(p.createdAt)}>{formatRelativeTime(p.createdAt)}</span>
          {p.appliedAt && <> · applied <span title={formatDateTime(p.appliedAt)}>{formatRelativeTime(p.appliedAt)}</span></>}
        </span>
      }
      actions={
        <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
          {(p.status === 'previewed' || p.status === 'draft' || p.status === 'reverted' || p.status === 'cancelled') && (
            <Button variant="secondary" onClick={run(previewM)} disabled={previewM.isPending || previewRequested}>
              {previewRequested || previewM.isPending ? 'Previewing…' : previewed ? 'Re-run preview' : 'Run preview'}
            </Button>
          )}
          {p.status === 'previewed' && (
            <Button variant="primary" onClick={run(applyM, `Write the previewed changes to ${stats?.filesTouched ?? 0} file(s)? Every write is journaled and can be reverted from this page.`)} disabled={!canApply || applyM.isPending || awaiting !== null} title={applyTitle}>
              {applyM.isPending || awaiting !== null ? 'Starting…' : 'Apply now'}
            </Button>
          )}
          {p.status === 'applying' && (
            <>
              <Button variant="secondary" onClick={run(pauseM)} disabled={pauseM.isPending}>Pause</Button>
              <Button variant="danger" onClick={run(cancelM, confirmStop)} disabled={cancelM.isPending}>Cancel</Button>
            </>
          )}
          {p.status === 'paused' && (
            <>
              <Button variant="primary" onClick={run(resumeM)} disabled={resumeM.isPending || awaiting !== null}>{awaiting !== null ? 'Resuming…' : 'Resume'}</Button>
              <Button variant="danger" onClick={run(cancelM, confirmStop)} disabled={cancelM.isPending}>Cancel</Button>
            </>
          )}
          {(p.status === 'applied' || p.status === 'partially_failed' || p.status === 'cancelled') && (progress?.applied ?? 0) > 0 && (
            <Button variant="danger" onClick={run(revertM, `Restore the previous tags on ${progress?.applied ?? 0} file(s)?`)} disabled={revertM.isPending || awaiting !== null}>
              {revertM.isPending || awaiting !== null ? 'Starting…' : 'Revert'}
            </Button>
          )}
        </div>
      }
    >
      <div className={styles.body}>
        {(tagWritesDisabled || noWritableRoots) && (
          <Banner tone="warning">
            <strong>This plan can be previewed but not applied yet.</strong>
            <ul style={{ margin: '0.4rem 0 0 0', paddingLeft: '1.1rem' }}>
              {tagWritesDisabled && <li>Tag writes are off — <Link to="/settings/library">Settings › Library › Tag writes</Link></li>}
              {noWritableRoots && <li>No scan root allows writes — <Link to="/settings/library">Settings › Library › Scan roots</Link></li>}
            </ul>
          </Banner>
        )}

        {error && <Banner tone="danger">{error}</Banner>}

        {!previewed && (
          <Banner tone="info">
            <strong>{previewRequested || previewM.isPending ? 'Computing the preview…' : 'No preview yet.'}</strong>{' '}
            Every file in scope is read once; a whole-library plan can take a few minutes. Nothing is written.
          </Banner>
        )}

        {p.status === 'paused' && stats?.lastError && (
          <Banner tone="danger">The last run stopped early: {stats.lastError}. Resume retries the files that were not written.</Banner>
        )}

        {p.status === 'partially_failed' && (
          <Banner tone="warning">
            <strong>{(statusCounts['failed'] ?? progress?.failed ?? 0).toLocaleString()} file(s) were not written.</strong>{' '}
            Filter the list by status "failed" to see why. A new plan over the same scope previews only what is still different.
          </Banner>
        )}

        {p.status === 'applied' && (
          <Banner tone="success">Applied. Check a file in your player; each album's History tab shows the write and offers the same revert.</Banner>
        )}

        {nothingToDo && (
          <Banner tone="info">Every file in scope already carries the canonical values under this policy. Nothing to apply.</Banner>
        )}

        {previewed && stats && (
          <div className={styles.stats}>
            <StatCard label="files change" value={stats.filesTouched.toLocaleString()} />
            <StatCard label="field changes" value={stats.fieldsModified.toLocaleString()} />
            <StatCard label="locked fields kept" value={stats.lockedFieldsRespected.toLocaleString()} />
            {stats.filesSkipped.length > 0 && <StatCard label="files skipped" value={stats.filesSkipped.length.toLocaleString()} tone="warning" />}
            {progress && progress.total > 0 && p.status !== 'previewed' && (
              <StatCard label="files written" value={progress.applied.toLocaleString()} tone={progress.failed ? 'warning' : 'success'} hint={progress.failed ? `${progress.failed.toLocaleString()} failed` : undefined} />
            )}
          </div>
        )}

        {progress && BUSY.has(p.status) && (
          <div className={styles.progress}>
            <div className={styles.bar}><div className={styles.fill} style={{ width: `${pct}%` }} /></div>
            <span>{done.toLocaleString()} / {progress.total.toLocaleString()} files{p.status === 'paused' ? ' · paused' : ''}</span>
          </div>
        )}

        {previewed && !nothingToDo && byField.length > 0 && (
          <Card title="Changes by field" actions={field ? <Button variant="ghost" size="sm" onClick={() => { setField(''); setOffset(0); }}>Show all fields</Button> : undefined}>
            <div className={styles.chips}>
              {byField.map(([f, v]) => (
                <button
                  key={f}
                  type="button"
                  className={`${styles.chip} ${field === f ? styles.chipActive : ''}`}
                  onClick={() => { setField(field === f ? '' : f); setOffset(0); }}
                  title={Object.entries(v.reasons).map(([r, n]) => `${n.toLocaleString()} ${reasonLabel(r)}`).join(' · ')}
                  aria-pressed={field === f}
                >
                  <span className={styles.chipField}>{f}</span>
                  <span className={styles.chipCount}>{v.files.toLocaleString()}</span>
                  <span className={styles.chipReason}>{Object.keys(v.reasons).map(reasonLabel).join('/')}</span>
                </button>
              ))}
            </div>
          </Card>
        )}

        {previewed && !nothingToDo && (
          <>
            <div className={styles.tools}>
              <select aria-label="Filter by write status" className={styles.select} value={itemStatus} onChange={(e) => { setItemStatus(e.target.value); setOffset(0); }}>
                <option value="">all files</option>
                {(['pending', 'applying', 'applied', 'failed', 'skipped'] as ItemStatus[]).filter((s) => (statusCounts[s] ?? 0) > 0).map((s) => (
                  <option key={s} value={s}>{s} · {(statusCounts[s] ?? 0).toLocaleString()}</option>
                ))}
              </select>
              <input className={styles.input} type="search" placeholder="Filter this page by path…" value={pathFilter} onChange={(e) => setPathFilter(e.target.value)} />
              <Button variant="ghost" size="sm" onClick={toggleAll}>{allOpen ? 'Collapse all' : 'Expand all'}</Button>
              <span className={styles.count}>
                {items.isLoading ? 'Loading…' : total === 0 ? 'No files' : `${(offset + 1).toLocaleString()}–${pageEnd.toLocaleString()} of ${total.toLocaleString()} files`}
              </span>
              <span className={styles.pager}>
                <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>‹</Button>
                <Button variant="secondary" size="sm" disabled={pageEnd >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>›</Button>
              </span>
            </div>

            <div className={styles.files}>
              {visibleItems.length === 0 && !items.isLoading && <div className={styles.empty}>No files match.</div>}
              {visibleItems.map((it) => {
                const rows = (it.diffs as TagDiffEntry[]).filter((d) => d.reason !== 'no-change');
                const open = isOpen(it.id);
                const dir = (it.relPath ?? '').split('/').slice(0, -1).join('/');
                const name = (it.relPath ?? it.audioFileId).split('/').pop();
                const st = (it.status ?? 'pending') as ItemStatus;
                const shown = rows.slice(0, 6);
                return (
                  <div key={it.id} className={styles.file}>
                    <button type="button" className={styles.fileRow} onClick={() => toggle(it.id)} aria-expanded={open}>
                      <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`}>▶</span>
                      <span><Badge tone={ITEM_TONE[st]}>{st}</Badge></span>
                      <span className={styles.path} title={it.relPath ?? it.audioFileId}>
                        <span className={styles.pathDir}>{dir}</span>
                        <span className={styles.pathFile}>{name}</span>
                        {it.error && <span className={styles.fileError} title={it.error}>{it.error}</span>}
                      </span>
                      <span className={styles.fileFields}>
                        <span className={styles.nChanges}>{rows.length} {rows.length === 1 ? 'change' : 'changes'}</span>
                        {!open && shown.map((d) => <span key={d.field} className={styles.fieldTag}>{d.field}</span>)}
                        {!open && rows.length > shown.length && <span className={styles.fieldMore}>+{rows.length - shown.length}</span>}
                      </span>
                    </button>
                    {open && (
                      <table className={styles.diff}>
                        <colgroup><col className={styles.colField} /><col /><col /><col className={styles.colWhy} /></colgroup>
                        <thead><tr><th>Field</th><th>Before</th><th>After</th><th>Why</th></tr></thead>
                        <tbody>
                          {rows.map((d) => (
                            <tr key={d.field}>
                              <td className={styles.cellField}>{d.field}</td>
                              <td className={styles.cellBefore}>{fmtValue(d.before)}</td>
                              <td>{d.reason === 'locked' ? <em>kept (locked)</em> : fmtValue(d.after)}</td>
                              <td className={styles.cellWhy}>{reasonLabel(d.reason)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}
