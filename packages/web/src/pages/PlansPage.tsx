/**
 * Tag plans page — list existing plans and create new ones (XO-358)
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { api } from '../services/api';
import type { TagPlan } from '@liner/shared';
import { PageShell, Button, Badge, statusTone, Table, Th, Td, TableRow, EmptyState, Tabs, type TabItem } from '../components/ui';
import { useCurrentLibrary } from '../hooks';
import { useTagPlans } from '../hooks/usePlanWizard';
import { PlanWizard } from '../components/PlanWizard';
import { formatDateTime, formatRelativeTime } from '../utils';
import styles from './PlansPage.module.css';

export function PlansPage() {
  const { libraryId } = useCurrentLibrary();
  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'done'>('all');
  const { data: plansResponse, isLoading } = useTagPlans(libraryId, { limit, offset });
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
    if (albumParam) void navigate({ to: '/plans', search: {} });
  };
  const initialScope = albumParam
    ? {
        albumIds: [albumParam],
        ...(albumForWizard.data ? { albumLabels: { [albumParam]: `${albumForWizard.data.artistCredit} — ${albumForWizard.data.title}` } } : {}),
      }
    : undefined;

  if (!libraryId) {
    return <PageShell title="Tag plans">Loading...</PageShell>;
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
    if (statusFilter === 'all') return true;
    if (statusFilter === 'active') {
      return ['draft', 'previewed', 'applying', 'paused'].includes(plan.status);
    }
    if (statusFilter === 'done') {
      return ['applied', 'reverted', 'cancelled', 'partially_failed'].includes(plan.status);
    }
    return true;
  });

  const statusTabs: TabItem[] = [
    { label: 'All', value: 'all', count: plans.length },
    {
      label: 'Active',
      value: 'active',
      count: plans.filter((p) => ['draft', 'previewed', 'applying', 'paused'].includes(p.status)).length,
    },
    {
      label: 'Done',
      value: 'done',
      count: plans.filter((p) => ['applied', 'reverted', 'cancelled', 'partially_failed'].includes(p.status)).length,
    },
  ];

  return (
    <PageShell
      title="Tag plans"
      subtitle="Preview and apply tag corrections"
      actions={
        <Button variant="primary" onClick={() => setShowWizard(true)}>
          Create plan
        </Button>
      }
      tabs={statusTabs}
      activeTab={statusFilter}
      onTabChange={(value) => {
        setStatusFilter(value as 'all' | 'active' | 'done');
        setOffset(0);
      }}
    >
      {isLoading ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading plans...</div>
      ) : filteredPlans.length === 0 ? (
        <EmptyState
          title="No plans"
          text={statusFilter === 'all' ? 'Create a tag plan to preview and apply corrections to your library' : undefined}
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
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Scope</Th>
                <Th>Status</Th>
                <Th style={{ textAlign: 'right' }}>Files</Th>
                <Th>Created</Th>
                <Th>Applied</Th>
              </tr>
            </thead>
            <tbody>
              {filteredPlans.map((plan) => {
                if (!plan) return null;
                return (
                  <TableRow key={plan.id} to={`/plans/${plan.id}`}>
                    <Td>{plan.name || 'Untitled plan'}</Td>
                    <Td className={styles.cellScope}>{scopeLabel(plan)}</Td>
                    <Td>
                      <Badge tone={statusTone(plan.status)}>
                        {plan.status.replaceAll('_', ' ')}
                      </Badge>
                    </Td>
                    <Td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {plan.stats?.filesTouched ?? '—'}
                    </Td>
                    <Td className={styles.cellDate}>
                      <span title={formatDateTime(plan.createdAt || '')}>
                        {formatRelativeTime(plan.createdAt || '')}
                      </span>
                    </Td>
                    <Td className={styles.cellDate}>
                      {plan.appliedAt ? (
                        <span title={formatDateTime(plan.appliedAt || '')}>
                          {formatRelativeTime(plan.appliedAt || '')}
                        </span>
                      ) : (
                        '—'
                      )}
                    </Td>
                  </TableRow>
                );
              })}
            </tbody>
          </Table>

          <div className={styles.pagination}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={!hasPrev}
            >
              Prev
            </Button>
            <span className={styles.paginationInfo}>
              {total === 0 ? '0' : `${offset + 1}–${Math.min(offset + limit, total)}`} of {total.toLocaleString()}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOffset(offset + limit)}
              disabled={!hasNext}
            >
              Next
            </Button>
          </div>
        </>
      )}

      {wizardOpen && (albumParam ? !albumForWizard.isLoading : true) && (
        <PlanWizard
          key={albumParam ?? 'blank'}
          libraryId={libraryId}
          onClose={closeWizard}
          {...(initialScope ? { initialScope } : {})}
        />
      )}
    </PageShell>
  );
}
