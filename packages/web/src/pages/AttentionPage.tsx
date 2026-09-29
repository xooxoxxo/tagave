/**
 * Needs Attention (spec §14.2): open gaps grouped by kind. Each row offers
 * the three choices (0032): add to my tasks, not a problem, this is wrong.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks';
import { api } from '../services/api';
import { GapChoices, GapChoicesHelp } from '../components/GapChoices';
import { gapLine, missingTrackLabel, titleList, type MissingTrack } from '../utils/gapTasks';
import styles from './AttentionPage.module.css';

interface GapItem {
  id: string;
  kind: string;
  flag?: string;
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
  quality: 'Tags, artwork and files',
  missing_album: 'Missing albums',
};

export function AttentionPanel() {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const [kind, setKind] = useState<string>('incomplete_album');

  const { data, isLoading } = useQuery({
    queryKey: ['gaps', libraryId, kind],
    queryFn: () =>
      api.get<{ counts: Record<string, number>; items: GapItem[]; nextCursor: string | null }>(
        `/libraries/${libraryId}/gaps?kind=${kind}&limit=100`,
      ),
    enabled: !!libraryId,
  });

  const counts = data?.counts ?? {};

  /** which tracks an incomplete album lacks, as a second line */
  const missingLine = (g: GapItem): string | null => {
    if (g.kind !== 'incomplete_album') return null;
    const missing = ((g.details as { missing?: MissingTrack[] }).missing ?? []);
    if (missing.length === 0) return null;
    return `${missingTrackLabel(missing)}: ${titleList(missing, 4)}`;
  };

  return (
    <div className={styles.container}>
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
      {data && data.items.length > 0 && <GapChoicesHelp />}

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
              <span className={styles.detail}>{gapLine(g)}</span>
              {missingLine(g) && <span className={styles.detailMore}>{missingLine(g)}</span>}
            </div>
            <GapChoices gapId={g.id} subject={`${g.subjectTitle ?? 'this album'}: ${gapLine(g)}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

// Legacy export for backwards compatibility
export function AttentionPage() {
  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Needs Attention</h1>
      <AttentionPanel />
    </div>
  );
}
