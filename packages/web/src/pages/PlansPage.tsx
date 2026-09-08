/**
 * Tag plans page — list existing plans and create new ones (XO-358)
 */

import { useState } from 'react';
import type { TagPlan } from '@liner/shared';
import { Link } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks';
import { useTagPlans } from '../hooks/usePlanWizard';
import { PlanWizard } from '../components/PlanWizard';
import { formatDateTime, formatRelativeTime } from '../utils';
import styles from './PlansPage.module.css';

export function PlansPage() {
  const { libraryId } = useCurrentLibrary();
  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);
  const { data: plansResponse, isLoading } = useTagPlans(libraryId, { limit, offset });
  const [showWizard, setShowWizard] = useState(false);

  if (!libraryId) {
    return <div className={styles.container}>Loading...</div>;
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

  const statusBadgeClass = (status: string): string => {
    switch (status) {
      case 'draft':
        return styles.statusDraft || '';
      case 'previewed':
        return styles.statusPreviewed || '';
      case 'applying':
      case 'paused':
        return styles.statusApplying || '';
      case 'applied':
        return styles.statusApplied || '';
      case 'reverted':
        return styles.statusReverted || '';
      case 'partially_failed':
      case 'cancelled':
        return styles.statusFailed || '';
      default:
        return styles.statusDefault || '';
    }
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Tag plans</h1>
          <p className={styles.subtitle}>Preview and apply tag corrections</p>
        </div>
        <button
          className={styles.createBtn}
          onClick={() => setShowWizard(true)}
        >
          Create plan
        </button>
      </header>

      {isLoading ? (
        <div className={styles.loading}>Loading plans...</div>
      ) : plans.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>No plans yet</p>
          <p className={styles.emptyText}>
            Create a tag plan to preview and apply corrections to your library
          </p>
          <button
            className={`${styles.createBtn} ${styles.emptyBtn}`}
            onClick={() => setShowWizard(true)}
          >
            Create your first plan
          </button>
        </div>
      ) : (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Scope</th>
                <th>Status</th>
                <th>Files</th>
                <th>Created</th>
                <th>Applied</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => {
                if (!plan) return null;
                return (
                  <tr key={plan.id} className={styles.row}>
                    <td className={styles.cellName}>
                      <Link to="/plans/$planId" params={{ planId: plan.id }} className={styles.planLink}>
                        {plan.name || 'Untitled plan'}
                      </Link>
                    </td>
                    <td className={styles.cellScope} title={scopeLabel(plan)}>{scopeLabel(plan)}</td>
                    <td className={styles.cellStatus}>
                      <span className={`${styles.badge} ${statusBadgeClass(plan.status)}`}>
                        {plan.status}
                      </span>
                    </td>
                    <td className={styles.cellNumber}>
                      {plan.stats?.filesTouched ?? '—'}
                    </td>
                    <td className={styles.cellDate}>
                      <span
                        className={styles.dateTooltip}
                        title={formatDateTime(plan.createdAt || '')}
                      >
                        {formatRelativeTime(plan.createdAt || '')}
                      </span>
                    </td>
                    <td className={styles.cellDate}>
                      {plan.appliedAt ? (
                        <span
                          className={styles.dateTooltip}
                          title={formatDateTime(plan.appliedAt || '')}
                        >
                          {formatRelativeTime(plan.appliedAt || '')}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className={styles.pagination}>
            <button
              className={styles.paginationBtn}
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={!hasPrev}
            >
              Prev
            </button>
            <span className={styles.paginationInfo}>
              {total === 0 ? '0' : `${offset + 1}–${Math.min(offset + limit, total)}`} of {total}
            </span>
            <button
              className={styles.paginationBtn}
              onClick={() => setOffset(offset + limit)}
              disabled={!hasNext}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {showWizard && (
        <PlanWizard
          libraryId={libraryId}
          onClose={() => setShowWizard(false)}
        />
      )}
    </div>
  );
}
