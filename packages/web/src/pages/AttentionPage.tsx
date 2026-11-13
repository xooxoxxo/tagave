/**
 * Needs Attention (spec §14.2): open gaps grouped by kind. Each row offers
 * the three choices (0032): add to my tasks, not a problem, this is wrong.
 */
import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCan, useCurrentLibrary } from '../hooks';
import { PHONE_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { Button } from '../components/ui';
import { api } from '../services/api';
import { GapChoices } from '../components/GapChoices';
import { gapLine, missingTrackLabel, titleList, type MissingTrack } from '../utils/gapTasks';
import styles from './AttentionPage.module.css';

// Whole album in one file: the split sheet, loaded the first time one opens
const SplitSheet = lazy(() => import('../components/SplitSheet').then((m) => ({ default: m.SplitSheet })));

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
  one_file_album: 'Whole album in one file',
};

export function AttentionPanel() {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const [kind, setKind] = useState<string>('incomplete_album');
  const canSplit = useCan('system.manage');
  const [splitting, setSplitting] = useState<GapItem | null>(null);
  const narrow = useMediaQuery(PHONE_QUERY);

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
        <div className={styles.empty}>Nothing open</div>
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
                  navigate({ to: '/albums/$albumId', params: { albumId: g.subjectId } as never, search: { issues: g.id } as never });
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
            {g.kind === 'one_file_album' && canSplit && (
              <Button variant="secondary" size="sm" onClick={() => setSplitting(g)}>Split</Button>
            )}
            <GapChoices gapId={g.id} subject={`${g.subjectTitle ?? 'this album'}: ${gapLine(g)}`} />
          </div>
        ))}
      </div>
      {splitting && (
        <Suspense fallback={null}>
          <SplitSheet
            open={!!splitting}
            onOpenChange={(open) => { if (!open) setSplitting(null); }}
            libraryId={libraryId}
            albumId={splitting.subjectId}
            title={splitting.subjectTitle ?? 'This album'}
            artist={splitting.subjectArtist}
            side={narrow ? 'bottom' : 'right'}
          />
        </Suspense>
      )}
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
