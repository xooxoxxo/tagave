/**
 * Tag plans page — list existing plans and create new ones (XO-358)
 */

import { useState } from 'react';
import { useCurrentLibrary } from '../hooks';
import { useTagPlans } from '../hooks/usePlanWizard';
import { PlanWizard } from '../components/PlanWizard';
import { formatDateTime, formatRelativeTime } from '../utils';
import styles from './PlansPage.module.css';

export function PlansPage() {
  const { libraryId } = useCurrentLibrary();
  const { data: plansResponse, isLoading } = useTagPlans(libraryId);
  const [showWizard, setShowWizard] = useState(false);

  if (!libraryId) {
    return <div className={styles.container}>Loading...</div>;
  }

  const plans = plansResponse?.data ?? [];

  const scopeLabel = (scope: Record<string, unknown> | undefined): string => {
    if (!scope) return 'Unknown';
    const type = scope?.type as string | undefined;
    switch (type) {
      case 'library':
        return 'Entire library';
      case 'artist':
        return `Artist: ${String(scope.artistId || '')}`;
      case 'albumIds':
        return `${(scope.albumIds as string[] | undefined)?.length ?? 0} album(s)`;
      case 'filterQuery':
        return `Query: ${JSON.stringify(scope.filterQuery || {})}`;
      default:
        return 'Unknown';
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
                      <a href={`#`} className={styles.planLink}>
                        {plan.name || 'Untitled plan'}
                      </a>
                    </td>
                    <td className={styles.cellScope}>{scopeLabel(plan.scope ?? {})}</td>
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
