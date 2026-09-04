/**
 * Needs Attention (spec §14.2): open gaps grouped by kind, dismissible.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks';
import { api } from '../services/api';
import styles from './AttentionPage.module.css';

interface GapItem {
  id: string;
  kind: string;
  subjectType: string;
  subjectId: string;
  subjectTitle: string | null;
  subjectArtist: string | null;
  details: Record<string, unknown>;
  firstSeenAt: string;
}

const KIND_LABEL: Record<string, string> = {
  incomplete_album: 'Incomplete albums',
  duplicate: 'Duplicates',
  quality: 'Quality flags',
  missing_album: 'Missing albums',
};

export function AttentionPage() {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<string>('incomplete_album');

  const { data, isLoading } = useQuery({
    queryKey: ['gaps', libraryId, kind],
    queryFn: () =>
      api.get<{ counts: Record<string, number>; items: GapItem[]; nextCursor: string | null }>(
        `/libraries/${libraryId}/gaps?kind=${kind}&limit=100`,
      ),
    enabled: !!libraryId,
  });

  const dismiss = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/gaps/${id}/dismiss`, { reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['gaps', libraryId] }),
  });

  const counts = data?.counts ?? {};

  const describe = (g: GapItem): string => {
    if (g.kind === 'incomplete_album') {
      const d = g.details as { have?: number; want?: number; missing?: { title?: string }[] };
      const names = (d.missing ?? []).slice(0, 3).map((m) => m.title).filter(Boolean).join(', ');
      return `${d.have}/${d.want} tracks — missing: ${names}${(d.missing?.length ?? 0) > 3 ? '…' : ''}`;
    }
    if (g.kind === 'duplicate') {
      const d = g.details as { count?: number };
      return `${d.count} local copies of the same release group`;
    }
    if (g.kind === 'quality') {
      const f = (g.details as { flags?: Record<string, unknown> }).flags ?? {};
      return Object.entries(f)
        .map(([k, v]) => (v === true ? k : `${k}: ${v}`))
        .join(' · ');
    }
    return JSON.stringify(g.details);
  };

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Needs Attention</h1>
      <div className={styles.tabs}>
        {Object.entries(KIND_LABEL).map(([k, label]) => (
          <button
            key={k}
            className={k === kind ? styles.tabActive : styles.tab}
            onClick={() => setKind(k)}
          >
            {label} {counts[k] ? <span className={styles.count}>{counts[k]}</span> : null}
          </button>
        ))}
      </div>

      {isLoading && <div className={styles.loading}>Loading...</div>}
      {data && data.items.length === 0 && (
        <div className={styles.empty}>Nothing open in this category.</div>
      )}

      <div className={styles.list}>
        {data?.items.map((g) => (
          <div key={g.id} className={styles.row}>
            <div
              className={styles.rowMain}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (g.subjectType === 'local_album') {
                  navigate({ to: '/albums/$albumId', params: { albumId: g.subjectId } as never });
                }
              }}
            >
              <span className={styles.subject}>
                {g.subjectArtist ? `${g.subjectArtist} — ` : ''}
                {g.subjectTitle ?? g.subjectId}
              </span>
              <span className={styles.detail}>{describe(g)}</span>
            </div>
            <div className={styles.rowActions}>
              <button onClick={() => dismiss.mutate({ id: g.id, reason: 'not_interested' })}>
                Dismiss
              </button>
              <button
                title="The data is wrong (feeds the false-positive metric)"
                onClick={() => dismiss.mutate({ id: g.id, reason: 'wrong_data' })}
              >
                Wrong
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
