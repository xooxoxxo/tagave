/**
 * Album detail (spec BRW-2): cover, canonical vs local metadata, tracklist
 * with duration comparison, file facts, match provenance — plus everything
 * needed to act without leaving: gaps with dismiss, missing tracks,
 * candidate accept/exclude, duplicate copies, art refetch, as-is/ignore.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks';
import { api } from '../services/api';
import styles from './AlbumDetailPage.module.css';

interface DetailTrack {
  id: string;
  discNo: number | null;
  trackNo: number | null;
  title: string | null;
  durationMs: number | null;
  origin: string;
  cueStartMs: number | null;
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
interface Candidate {
  id: string;
  releaseMbid: string | null;
  discogsReleaseId: number | null;
  title: string;
  artistCredit: string;
  date: string | null;
  country: string | null;
  status: string | null;
  trackCount: number | null;
  distance: number;
  source: string;
  provider: string;
  rgMbid: string | null;
  excluded: boolean;
}
interface Gap {
  id: string;
  kind: string;
  state: string;
  dismissReason: string | null;
  details: Record<string, unknown>;
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
  isCueImage: boolean;
  cueRelPath: string | null;
  release: {
    mbid: string | null;
    title: string;
    date: string | null;
    country: string | null;
    status: string | null;
    labels: { name: string; catno?: string }[] | null;
    trackCount: number | null;
    artistCredit: string[] | string | null;
    discogsReleaseId: number | null;
    discogsMasterId: number | null;
    sourceOfTruth: string;
    externalLinks: Array<{ title: string; url: string; source: string }>;
    genres?: string[];
    styles?: string[];
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
  missingTracks: { disc: number; position: number; title: string; lengthMs: number | null }[];
  gaps: Gap[];
  candidates: Candidate[];
  duplicates: {
    id: string;
    title: string | null;
    artist: string | null;
    trackCount: number | null;
    formats: string[] | null;
    state: string;
    dirPaths: string[] | null;
  }[];
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

const GAP_LABEL: Record<string, string> = {
  incomplete_album: 'Incomplete',
  duplicate: 'Duplicate',
  quality: 'Quality',
  missing_album: 'Missing album',
};

export function AlbumDetailPage() {
  const { albumId } = useParams({ strict: false }) as { albumId: string };
  const { libraryId } = useCurrentLibrary();
  const queryClient = useQueryClient();
  const [showExcluded, setShowExcluded] = useState(false);
  const [mbidInput, setMbidInput] = useState('');

  const refresh = (delayMs = 0) =>
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['album', albumId] });
      queryClient.invalidateQueries({ queryKey: ['albums'] });
    }, delayMs);

  const { data: album, isLoading } = useQuery({
    queryKey: ['album', albumId],
    queryFn: () => api.get<AlbumDetail>(`/libraries/${libraryId}/albums/${albumId}`),
    enabled: !!libraryId && !!albumId,
  });

  const reidentify = useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/albums/${albumId}/identify`),
    onSuccess: () => refresh(4000),
  });
  const fetchArt = useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/albums/${albumId}/fetch-art`),
    onSuccess: () => refresh(5000),
  });
  const keepAsIs = useMutation({
    mutationFn: () => api.post(`/albums/${albumId}/as-is`),
    onSuccess: () => refresh(),
  });
  const ignore = useMutation({
    mutationFn: () => api.post(`/albums/${albumId}/ignore`),
    onSuccess: () => refresh(),
  });
  const acceptCandidate = useMutation({
    mutationFn: (candidateId: string) => api.post(`/albums/${albumId}/match`, { candidateId }),
    onSuccess: () => refresh(),
  });
  const excludeCandidate = useMutation({
    mutationFn: (candidateId: string) => api.post(`/albums/${albumId}/exclude-candidate`, { candidateId }),
    onSuccess: () => refresh(),
  });
  const matchMbid = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean }>(`/libraries/${libraryId}/albums/${albumId}/match-mbid`, {
        input: mbidInput,
      }),
    onSuccess: () => {
      setMbidInput('');
      refresh(6000);
    },
  });

  const dismissGap = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/gaps/${id}/dismiss`, { reason }),
    onSuccess: () => refresh(),
  });
  const reopenGap = useMutation({
    mutationFn: (id: string) => api.post(`/gaps/${id}/reopen`),
    onSuccess: () => refresh(),
  });

  if (isLoading || !album) return <div className={styles.container}>Loading album...</div>;

  const durationDrift = (t: DetailTrack) =>
    t.canonicalDurationMs && t.durationMs
      ? Math.abs(t.canonicalDurationMs - t.durationMs) > 5000
      : false;

  const openGaps = album.gaps.filter((g) => g.state === 'open');
  const dismissedGaps = album.gaps.filter((g) => g.state === 'dismissed');
  const visibleCandidates = album.candidates.filter((c) => showExcluded || !c.excluded);
  const excludedCount = album.candidates.filter((c) => c.excluded).length;
  const qualityFlags = (openGaps.find((g) => g.kind === 'quality')?.details as { flags?: Record<string, unknown> } | undefined)?.flags ?? {};

  const describeGap = (g: Gap): string => {
    if (g.kind === 'incomplete_album') {
      const d = g.details as { have?: number; want?: number };
      return `${d.have}/${d.want} tracks`;
    }
    if (g.kind === 'duplicate') return `${(g.details as { count?: number }).count} copies of this release group`;
    if (g.kind === 'quality') {
      return Object.entries(qualityFlags).map(([k, v]) => (v === true ? k : `${k}: ${v}`)).join(' · ');
    }
    return '';
  };

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
            {openGaps.map((g) => (
              <span key={g.id} className={styles.gapBadge} title={describeGap(g)}>
                {GAP_LABEL[g.kind] ?? g.kind}
              </span>
            ))}
            {album.match && (
              <span className={styles.provenance} title={album.match.reason ?? ''}>
                {album.match.decidedBy === 'system' ? 'auto' : 'you'} · distance{' '}
                {album.match.distance.toFixed(4)}
                {album.match.decidedAt ? ` · ${new Date(album.match.decidedAt).toLocaleDateString()}` : ''}
              </span>
            )}
            {album.coverOrigin && <span className={styles.provenance}>cover: {album.coverOrigin}</span>}
            {album.isCueImage && <span className={styles.provenance} title={album.cueRelPath ?? ''}>Cue image</span>}
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
            {album.release?.discogsReleaseId && (
              <a
                className={styles.mbLink}
                href={`https://www.discogs.com/release/${album.release.discogsReleaseId}`}
                target="_blank"
                rel="noreferrer"
              >
                Discogs ↗
              </a>
            )}
            {album.release?.discogsMasterId && (
              <a
                className={styles.mbLink}
                href={`https://www.discogs.com/master/${album.release.discogsMasterId}`}
                target="_blank"
                rel="noreferrer"
              >
                Master ↗
              </a>
            )}
            {album.release?.sourceOfTruth === 'discogs' && !album.release?.mbid && (
              <span className={styles.provenance}>Discogs-only</span>
            )}
          </div>
          <div className={styles.dirPath}>{album.dirPaths?.[0]}</div>
          {((album.release?.genres?.length ?? 0) + (album.release?.styles?.length ?? 0)) > 0 && (
            <div className={styles.badgeRow} title="Genres and styles (Discogs, CC0)">
              {album.release?.genres?.map((g) => (
                <span key={`g-${g}`} className={styles.provenance}>{g}</span>
              ))}
              {album.release?.styles?.map((st) => (
                <span key={`s-${st}`} className={styles.gapBadge}>{st}</span>
              ))}
            </div>
          )}
          <div className={styles.actions}>
            <button onClick={() => reidentify.mutate()} disabled={reidentify.isPending}>
              {reidentify.isPending ? 'Queued...' : 'Re-identify'}
            </button>
            <button onClick={() => fetchArt.mutate()} disabled={fetchArt.isPending}>
              {fetchArt.isPending ? 'Queued...' : album.coverUrl ? 'Refetch art' : 'Fetch art'}
            </button>
            {album.state !== 'as_is' && (
              <button onClick={() => keepAsIs.mutate()} disabled={keepAsIs.isPending}>
                Keep as-is
              </button>
            )}
            {album.state !== 'ignored' && (
              <button onClick={() => ignore.mutate()} disabled={ignore.isPending}>
                Ignore
              </button>
            )}
          </div>
          <div className={styles.mbidRow}>
            <input
              className={styles.mbidInput}
              placeholder="Paste a MusicBrainz or Discogs release URL / ID to match manually"
              value={mbidInput}
              onChange={(e) => setMbidInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && mbidInput.trim()) matchMbid.mutate();
              }}
            />
            <button
              onClick={() => matchMbid.mutate()}
              disabled={!mbidInput.trim() || matchMbid.isPending}
            >
              {matchMbid.isPending ? 'Matching...' : 'Match'}
            </button>
            {matchMbid.isError && (
              <span className={styles.mbidError}>
                {(matchMbid.error as { detail?: string; message?: string })?.detail ??
                  (matchMbid.error as Error)?.message ?? 'Failed'}
              </span>
            )}
            {matchMbid.isSuccess && <span className={styles.mbidOk}>Queued — updates in a few seconds</span>}
          </div>
        </div>
      </div>

      {openGaps.length > 0 && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Needs attention</h2>
          {openGaps.map((g) => (
            <div key={g.id} className={styles.gapRow}>
              <span className={styles.gapKind}>{GAP_LABEL[g.kind] ?? g.kind}</span>
              <span className={styles.gapDetail}>{describeGap(g)}</span>
              <span className={styles.gapActions}>
                <button onClick={() => dismissGap.mutate({ id: g.id, reason: 'not_interested' })}>
                  Dismiss
                </button>
                <button
                  title="The data is wrong (feeds the false-positive metric)"
                  onClick={() => dismissGap.mutate({ id: g.id, reason: 'wrong_data' })}
                >
                  Wrong
                </button>
              </span>
            </div>
          ))}
          {dismissedGaps.map((g) => (
            <div key={g.id} className={styles.gapRowDismissed}>
              <span className={styles.gapKind}>{GAP_LABEL[g.kind] ?? g.kind}</span>
              <span className={styles.gapDetail}>
                dismissed ({g.dismissReason ?? 'no reason'})
              </span>
              <span className={styles.gapActions}>
                <button onClick={() => reopenGap.mutate(g.id)}>Reopen</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {album.missingTracks.length > 0 && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>
            Missing tracks ({album.missingTracks.length})
          </h2>
          <table className={styles.missingTable}>
            <tbody>
              {album.missingTracks.map((m, i) => (
                <tr key={i}>
                  <td className={styles.num}>
                    {(album.discCount ?? 1) > 1 ? `${m.disc}-` : ''}
                    {m.position}
                  </td>
                  <td>{m.title}</td>
                  <td className={styles.num}>{dur(m.lengthMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {album.duplicates.length > 0 && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Other copies ({album.duplicates.length})</h2>
          {album.duplicates.map((d) => (
            <div key={d.id} className={styles.dupRow}>
              <Link to="/albums/$albumId" params={{ albumId: d.id } as never} className={styles.dupLink}>
                {d.title ?? 'Untitled'}
              </Link>
              <span className={styles.gapDetail}>
                {[d.formats?.join('/'), `${d.trackCount} tracks`, STATE_LABEL[d.state] ?? d.state]
                  .filter(Boolean).join(' · ')}
              </span>
              <span className={styles.dupPath}>{d.dirPaths?.[0]}</span>
            </div>
          ))}
        </div>
      )}

      {album.candidates.length > 0 && album.state !== 'matched' && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>
            Match candidates ({visibleCandidates.length})
            {excludedCount > 0 && (
              <button className={styles.linkButton} onClick={() => setShowExcluded((s) => !s)}>
                {showExcluded ? 'hide' : 'show'} {excludedCount} excluded
              </button>
            )}
          </h2>
          <table className={styles.candTable}>
            <thead>
              <tr>
                <th>Distance</th>
                <th>Release</th>
                <th>Date</th>
                <th>Country</th>
                <th>Tracks</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleCandidates.map((c) => (
                <tr key={c.id} className={c.excluded ? styles.candExcluded : ''}>
                  <td className={styles.num}>{c.distance.toFixed(4)}</td>
                  <td>
                    <span className={styles.provenance} title={`Provider: ${c.provider}`}>
                      {c.provider === 'discogs' ? 'Discogs' : 'MB'}
                    </span>
                    {c.title}
                    <span className={styles.gapDetail}> — {c.artistCredit}</span>
                    {c.releaseMbid && (
                      <a
                        className={styles.mbLink}
                        href={`https://musicbrainz.org/release/${c.releaseMbid}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {' '}↗
                      </a>
                    )}
                    {c.discogsReleaseId && (
                      <a
                        className={styles.mbLink}
                        href={`https://www.discogs.com/release/${c.discogsReleaseId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {' '}🔗
                      </a>
                    )}
                  </td>
                  <td>{c.date ?? '–'}</td>
                  <td>{c.country ?? '–'}</td>
                  <td className={styles.num}>{c.trackCount ?? '–'}</td>
                  <td className={styles.gapActions}>
                    {!c.excluded && (
                      <>
                        <button
                          onClick={() => acceptCandidate.mutate(c.id)}
                          disabled={acceptCandidate.isPending}
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => excludeCandidate.mutate(c.id)}
                          disabled={excludeCandidate.isPending}
                        >
                          Exclude
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
                {t.origin === 'cue' && t.cueStartMs !== null && (
                  <span> @ {dur(t.cueStartMs)}</span>
                )}
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

      {(album.release?.discogsReleaseId || album.release?.discogsMasterId || album.candidates.some(c => c.discogsReleaseId)) && (
        <div className={styles.attribution}>
          <span>
            Data provided by{' '}
            <a href="https://www.discogs.com" target="_blank" rel="noreferrer">
              Discogs
            </a>
          </span>
        </div>
      )}
    </div>
  );
}
