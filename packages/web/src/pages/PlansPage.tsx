/**
 * Tag changes page — list existing plans and create new ones (XO-358)
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { api } from '../services/api';
import { isFinishedPlanStatus, type TagPlan } from '@tagave/shared';
import { PageShell, Button, IconButton, Badge, Table, Th, Td, TableRow, EmptyState, Tabs, type TabItem } from '../components/ui';
import { useCurrentLibrary } from '../hooks';
import { useTagPlans, useDeleteTagPlan, useRenameTagPlan, useArchiveTagPlan } from '../hooks/usePlanWizard';
import { InlineRename } from '../components/InlineRename';
import { PlanWizard } from '../components/PlanWizard';
import { wizardCloseNavigation } from '../components/planWizardHistory';
import { formatDateTime, formatRelativeTime } from '../utils';
import { planStatusView } from '../utils/planStatus';
import styles from './PlansPage.module.css';
import { KEPT_PLAN_NOTE } from './planResultsText';

export function PlansPage() {
  const { libraryId } = useCurrentLibrary();
  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'done' | 'archived'>('all');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Archived plans come from their own list; the other tabs leave them out.
  const showArchived = statusFilter === 'archived';
  // the other tabs' counts, kept while the Archived tab is open
  const [lastCounts, setLastCounts] = useState<{ all: number; active: number; done: number } | null>(null);
  const { data: plansResponse, isLoading } = useTagPlans(libraryId, { limit, offset, archived: showArchived });
  const navigate = useNavigate();
  const { album: albumParam } = useSearch({ strict: false }) as { album?: string };
  const [showWizard, setShowWizard] = useState(false);
  const albumForWizard = useQuery({
    queryKey: ['album-label', libraryId, albumParam],
    queryFn: () => api.get<{ title: string; artistCredit: string }>(`/libraries/${libraryId}/albums/${albumParam}`),
    enabled: !!libraryId && !!albumParam,
    staleTime: 5 * 60 * 1000,
  });
  const wizardOpen = showWizard || !!albumParam;
  const closeWizard = () => {
    setShowWizard(false);
    const nav = wizardCloseNavigation(albumParam);
    if (nav) void navigate(nav);
  };
  const initialScope = albumParam
    ? {
        albumIds: [albumParam],
        ...(albumForWizard.data ? { albumLabels: { [albumParam]: `${albumForWizard.data.artistCredit} — ${albumForWizard.data.title}` } } : {}),
      }
    : undefined;

  if (!libraryId) {
    return <PageShell title="Tag changes">Loading...</PageShell>;
  }

  const plans = plansResponse?.items ?? [];
  const total = plansResponse?.total ?? 0;
  const hasNext = offset + limit < total;
  const hasPrev = offset > 0;

  // The API resolves artist names; this fallback only covers older responses.
  const scopeLabel = (plan: Pick<TagPlan, 'scope' | 'scopeLabel'>): string => {
    if (plan.scopeLabel) return plan.scopeLabel;
    const scope = plan.scope;
    switch (scope.type) {
      case 'library':
        return 'Entire library';
      case 'artist':
        return 'One artist';
      case 'albumIds':
        return scope.albumIds.length === 1 ? '1 album' : `${scope.albumIds.length} albums`;
      case 'filterQuery':
        return 'Filtered albums';
      default:
        return 'Unknown scope';
    }
  };

  // Filter plans based on status
  const filteredPlans = plans.filter((plan) => {
    if (statusFilter === 'all' || statusFilter === 'archived') return true;
    if (statusFilter === 'active') {
      return ['draft', 'previewed', 'applying', 'paused'].includes(plan.status);
    }
    if (statusFilter === 'done') {
      return ['applied', 'reverted', 'cancelled', 'partially_failed'].includes(plan.status);
    }
    return true;
  });

  // Counts of the visible list; the Archived tab keeps its last known count
  // while it is open (its own list has only archived plans).
  const liveCounts = showArchived ? null : {
    all: plans.length,
    active: plans.filter((p) => ['draft', 'previewed', 'applying', 'paused'].includes(p.status)).length,
    done: plans.filter((p) => ['applied', 'reverted', 'cancelled', 'partially_failed'].includes(p.status)).length,
  };
  if (liveCounts && plansResponse && JSON.stringify(liveCounts) !== JSON.stringify(lastCounts)) setLastCounts(liveCounts);
  const counts = liveCounts ?? lastCounts;
  const statusTabs: TabItem[] = [
    { label: 'All', value: 'all', ...(counts ? { count: counts.all } : {}) },
    { label: 'Active', value: 'active', ...(counts ? { count: counts.active } : {}) },
    { label: 'Finished', value: 'done', ...(counts ? { count: counts.done } : {}) },
    { label: 'Archived', value: 'archived', count: plansResponse?.archivedCount ?? 0 },
  ];

  return (
    <PageShell
      title="Tag changes"
      titleAction={
        <IconButton label="Create plan" variant="primary" onClick={() => setShowWizard(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </IconButton>
      }
      tabs={statusTabs}
      activeTab={statusFilter}
      onTabChange={(value) => {
        setStatusFilter(value as 'all' | 'active' | 'done' | 'archived');
        setOffset(0);
      }}
    >
      {isLoading ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading plans...</div>
      ) : filteredPlans.length === 0 ? (
        <EmptyState
          title={showArchived ? 'No archived plans' : 'No plans'}
          text={statusFilter === 'all' ? 'Create a tag plan to preview and apply corrections to your library' : showArchived ? 'Archive a finished plan to keep it out of the list.' : undefined}
          action={
            statusFilter === 'all' ? (
              <Button variant="primary" size="sm" onClick={() => setShowWizard(true)}>
                Create your first plan
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table className={styles.plansTable}>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Scope</Th>
                <Th>Status</Th>
                <Th style={{ textAlign: 'right' }}>Files</Th>
                <Th style={{ textAlign: 'right' }}>Created</Th>
                <Th style={{ textAlign: 'right' }}>Applied</Th>
                <Th style={{ textAlign: 'right', width: 'auto' }} />
              </tr>
            </thead>
            <tbody>
              {filteredPlans.map((plan) => {
                if (!plan) return null;
                return (
                  <PlanRow
                    key={plan.id}
                    plan={plan}
                    libraryId={libraryId}
                    scope={scopeLabel(plan)}
                    confirming={confirmDeleteId === plan.id}
                    onConfirm={setConfirmDeleteId}
                  />
                );
              })}
            </tbody>
          </Table>

          <div className={styles.pagination}>
            {(hasPrev || hasNext) && <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={!hasPrev}
            >
              Prev
            </Button>
            </>}
            <span className={styles.paginationInfo}>
              {total === 0 ? '0' : `${offset + 1}–${Math.min(offset + limit, total)}`} of {total.toLocaleString()}
            </span>
            {(hasPrev || hasNext) && <Button
              variant="secondary"
              size="sm"
              onClick={() => setOffset(offset + limit)}
              disabled={!hasNext}
            >
              Next
            </Button>}
          </div>
        </>
      )}

      {wizardOpen && (albumParam ? !albumForWizard.isLoading : true) && (
        <PlanWizard
          key={albumParam ?? 'blank'}
          libraryId={libraryId}
          onClose={closeWizard}
          replaceHistoryOnDone={!!albumParam}
          {...(initialScope ? { initialScope } : {})}
        />
      )}
    </PageShell>
  );
}

/**
 * One plan in the list. A module-level component (it used to be defined
 * inside the page, so every re-render remounted every row and a rename in
 * progress would have been thrown away by a background refetch).
 */
function PlanRow({ plan, libraryId, scope, confirming, onConfirm }: {
  plan: TagPlan;
  libraryId: string;
  scope: string;
  confirming: boolean;
  onConfirm: (id: string | null) => void;
}) {
  const deleteM = useDeleteTagPlan(libraryId, plan.id);
  const renameM = useRenameTagPlan(libraryId);
  const archiveM = useArchiveTagPlan(libraryId);
  const archived = !!plan.archivedAt;
  // Finished plans can be archived (and brought back); archiving keeps the
  // plan, so a plan that wrote files can still be reverted from its page.
  const canArchive = archived || isFinishedPlanStatus(plan.status);
  const toggleArchive = async () => {
    setError(null);
    try {
      await archiveM.mutateAsync({ planId: plan.id, archived: !archived });
    } catch (e) {
      setError((e as { detail?: string; message?: string })?.detail ?? (e as Error).message ?? 'The plan could not be archived.');
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [keptNote, setKeptNote] = useState(false);
  const status = planStatusView(plan.status, plan.progress);

  const handleDelete = async () => {
    if (!confirming) {
      setError(null);
      onConfirm(plan.id);
      return;
    }
    try {
      await deleteM.mutateAsync();
      onConfirm(null);
    } catch (e) {
      setError((e as { detail?: string; message?: string })?.detail ?? (e as Error).message ?? 'The plan could not be deleted.');
      onConfirm(null);
    }
  };

  // A plan that wrote files holds the old tags Revert puts back; it is kept
  // (the API refuses too). Once reverted it can go.
  const wroteFiles = (plan.progress?.['applied'] ?? 0) > 0 && plan.status !== 'reverted';
  const deletableStatus = ['draft', 'previewed', 'reverted', 'cancelled', 'applied', 'partially_failed'].includes(plan.status);
  const canDelete = deletableStatus && !wroteFiles;

  const cells = (
    <>
      <Td className={styles.cellName}>
        <InlineRename
          size="row"
          value={plan.name || 'Untitled plan'}
          label={`Rename ${plan.name || 'plan'}`}
          onSave={(name) => renameM.mutateAsync({ planId: plan.id, name })}
        />
        {error && <span className={styles.rowError} role="alert">{error}</span>}
        {keptNote && wroteFiles && <span className={styles.rowNote} role="status">{KEPT_PLAN_NOTE}</span>}
      </Td>
      <Td className={styles.cellScope}>{scope}</Td>
      <Td className={styles.cellStatus}>
        <Badge tone={status.tone}>{status.label}</Badge>
      </Td>
      <Td className={`${styles.cellFiles} ${plan.stats ? '' : styles.cellEmpty}`} data-label={plan.stats ? 'files' : undefined}>
        {plan.stats?.filesTouched ?? '—'}
      </Td>
      <Td className={styles.cellDate} data-label="Created">
        <span title={formatDateTime(plan.createdAt || '')}>
          {formatRelativeTime(plan.createdAt || '')}
        </span>
      </Td>
      <Td className={`${styles.cellDate} ${plan.appliedAt ? '' : styles.cellEmpty}`} data-label="Applied">
        {plan.appliedAt ? (
          <span title={formatDateTime(plan.appliedAt || '')}>
            {formatRelativeTime(plan.appliedAt || '')}
          </span>
        ) : (
          '—'
        )}
      </Td>
      <Td className={styles.cellActions} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <div className={styles.rowActions}>
        {canArchive && !confirming && (
          <Button
            variant="quiet"
            size="sm"
            loading={archiveM.isPending}
            onClick={() => void toggleArchive()}
            title={archived ? 'Bring this plan back to the list' : 'Hide this finished plan from the list'}
          >
            {archived ? 'Unarchive' : 'Archive'}
          </Button>
        )}
        {deletableStatus && wroteFiles && (
          /* Kept: a faint Delete that says why rather than a gap in the row. */
          <Button
            variant="ghost"
            size="sm"
            className={styles.keptDelete}
            aria-disabled="true"
            aria-expanded={keptNote}
            title={KEPT_PLAN_NOTE}
            onClick={() => setKeptNote((v) => !v)}
          >
            Delete
          </Button>
        )}
        {canDelete && (
          <div style={{ display: 'flex', gap: 'var(--space-xs)', justifyContent: 'flex-end', alignItems: 'center' }}>
            {/* Quiet danger text in both states. A destructive action on
                every row should not outweigh "Create plan"; arming it only
                changes the label. */}
            <Button
              variant="quiet-danger"
              size="sm"
              loading={deleteM.isPending}
              onClick={handleDelete}
              disabled={deleteM.isPending}
              title={confirming ? 'Click again to delete permanently' : 'Delete this plan'}
            >
              {deleteM.isPending ? 'Deleting…' : confirming ? 'Really?' : 'Delete'}
            </Button>
            {confirming && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onConfirm(null)}
                disabled={deleteM.isPending}
              >
                Cancel
              </Button>
            )}
          </div>
        )}
        </div>
      </Td>
    </>
  );

  return confirming ? <TableRow>{cells}</TableRow> : <TableRow to={`/plans/${plan.id}`}>{cells}</TableRow>;
}
