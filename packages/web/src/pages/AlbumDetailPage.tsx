/**
 * Album detail (spec BRW-2, M1 slice): cover, canonical vs local metadata,
 * tracklist with duration comparison, file facts, match provenance.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks';
import { api } from '../services/api';
import styles from './AlbumDetailPage.module.css';

interface DetailTrack {
  id: string;
  discNo: number | null;
  trackNo: number | null;
  title: string | null;
  durationMs: number | null;
  canonicalTitle: string | null;
  canonicalDurationMs: number | null;
  file: {
    relPath: string;
    codec: string | null;
    lossless: boolean | null;
    bitrateKbps: number | null;
    sampleRate: number | null;
    bitDepth: number | null;
    sizeBytes: number | null;
    status: string;
  };
}
interface AlbumDetail {
  id: string;
  title: string | null;
  artistCredit: string | null;
  year: number | null;
  state: string;
  dirPaths: string[];
  formats: string[];
  discCount: number | null;
  trackCount: number | null;
  totalDurationMs: number | null;
  coverUrl: string | null;
  coverOrigin: string | null;
  release: {
    mbid: string | null;
    title: string;
    date: string | null;
    country: string | null;
    status: string | null;
    labels: { name: string; catno?: string }[] | null;
    trackCount: number | null;
    artistCredit: string[] | string | null;
    fetchedAt: string | null;
  } | null;
  match: {
    status: string;
    decidedBy: string;
    distance: number;
    decidedAt: string | null;
    reason: string | null;
  } | null;
  tracks: DetailTrack[];
}

function dur(ms: number | null | undefined): string {
  if (!ms) return '–:––';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function mb(bytes: number | null): string {
  return bytes ? `${(bytes / 1048576).toFixed(1)} MB` : '';
}

const STATE_LABEL: Record<string, string> = {
  matched: 'Matched',
  needs_review: 'Needs review',
  pending: 'Awaiting identification',
  unidentified: 'Unidentified',
  as_is: 'Kept as-is',
  ignored: 'Ignored',
};

export function AlbumDetailPage() {
  const { albumId } = useParams({ strict: false }) as { albumId: string };
  const { libraryId } = useCurrentLibrary();
  const queryClient = useQueryClient();

  const { data: album, isLoading } = useQuery({
    queryKey: ['album', albumId],
    queryFn: () => api.get<AlbumDetail>(`/libraries/${libraryId}/albums/${albumId}`),
    enabled: !!libraryId && !!albumId,
  });

  const reidentify = useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/albums/${albumId}/identify`),
    onSuccess: () => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['album', albumId] }), 4000);
    },
  });

  if (isLoading || !album) return <div className={styles.container}>Loading album...</div>;

  const durationDrift = (t: DetailTrack) =>
    t.canonicalDurationMs && t.durationMs
      ? Math.abs(t.canonicalDurationMs - t.durationMs) > 5000
      : false;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.coverBox}>
          {album.coverUrl ? (
            <img className={styles.cover} src={album.coverUrl} alt="" />
          ) : (
            <div className={styles.coverPlaceholder}>{album.trackCount}</div>
          )}
        </div>
        <div className={styles.headInfo}>
          <h1 className={styles.title}>{album.release?.title ?? album.title ?? 'Untitled'}</h1>
          <div className={styles.artist}>
            {Array.isArray(album.release?.artistCredit)
              ? album.release?.artistCredit.join(', ')
              : album.release?.artistCredit ?? album.artistCredit ?? 'Unknown artist'}
          </div>
          <div className={styles.metaRow}>
            {[
              album.release?.date ?? album.year,
              album.release?.country,
              album.release?.labels?.[0]?.name,
              `${album.trackCount} tracks`,
              dur(album.totalDurationMs),
              album.formats?.join(', '),
            ].filter(Boolean).join(' · ')}
          </div>
          <div className={styles.badgeRow}>
            <span className={styles[`state_${album.state}`] ?? styles.stateBadge}>
              {STATE_LABEL[album.state] ?? album.state}
            </span>
            {album.match && (
              <span className={styles.provenance} title={album.match.reason ?? ''}>
                {album.match.decidedBy === 'system' ? 'auto' : 'you'} · distance{' '}
                {album.match.distance.toFixed(4)}
                {album.match.decidedAt ? ` · ${new Date(album.match.decidedAt).toLocaleDateString()}` : ''}
              </span>
            )}
            {album.coverOrigin && <span className={styles.provenance}>cover: {album.coverOrigin}</span>}
            {album.release?.mbid && (
              <a
                className={styles.mbLink}
                href={`https://musicbrainz.org/release/${album.release.mbid}`}
                target="_blank"
                rel="noreferrer"
              >
                MusicBrainz ↗
              </a>
            )}
          </div>
          <div className={styles.dirPath}>{album.dirPaths?.[0]}</div>
          <div className={styles.actions}>
            <button onClick={() => reidentify.mutate()} disabled={reidentify.isPending}>
              {reidentify.isPending ? 'Queued...' : 'Re-identify'}
            </button>
          </div>
        </div>
      </div>

      <table className={styles.trackTable}>
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Length</th>
            {album.release && <th>Canonical</th>}
            <th>File</th>
          </tr>
        </thead>
        <tbody>
          {album.tracks.map((t) => (
            <tr key={t.id} className={t.file.status === 'error' ? styles.trackError : ''}>
              <td className={styles.num}>
                {t.discNo && (album.discCount ?? 1) > 1 ? `${t.discNo}-` : ''}
                {t.trackNo ?? '–'}
              </td>
              <td>
                {t.title ?? '(untitled)'}
                {t.canonicalTitle && t.canonicalTitle !== t.title && (
                  <span className={styles.canonTitle}> → {t.canonicalTitle}</span>
                )}
              </td>
              <td className={durationDrift(t) ? styles.durDrift : styles.num}>
                {dur(t.durationMs)}
              </td>
              {album.release && (
                <td className={styles.num}>{dur(t.canonicalDurationMs)}</td>
              )}
              <td className={styles.fileCell}>
                {[
                  t.file.codec,
                  t.file.lossless
                    ? `${t.file.bitDepth ?? '?'}bit/${((t.file.sampleRate ?? 0) / 1000).toFixed(1)}kHz`
                    : t.file.bitrateKbps
                      ? `${t.file.bitrateKbps}kbps`
                      : null,
                  mb(t.file.sizeBytes),
                ].filter(Boolean).join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
