/**
 * Artist page (spec BRW-3; approved prototype "artist-directions", 0.7.6).
 *
 * Two layouts, chosen in Settings › Appearance › Artist page: Name first
 * (ArtistNameFirst, the default) and Like albums (ArtistLikeAlbums). Both
 * draw the album page's header — back and Maintenance keys that dock into a
 * strip with the artist's name once the name scrolls under them — and both
 * list what the library holds of the artist (identified albums, albums known
 * by their tags, the shelf) and what a followed artist is missing.
 *
 * The details (kind, country, years, aliases, biography) come from
 * MusicBrainz and Wikipedia in the background; while they are on their way
 * the page says so, and it stops waiting after a minute instead of spinning.
 */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import {
  useCan, useCurrentLibrary, useArtist, useEnrichArtist, useFollowArtist, useReopenGap, useFollowRules,
  usePatchArtistFollowRules, useResetArtistFollowRules,
} from '../hooks';
import { PageShell, Button, IconButton } from '../components/ui';
import { PageBackActionContext } from '../components/ui/PageShell';
import { artistLabel } from '@tagave/shared';
import { useMaintenance } from '../maintenance';
import { useDisplayPrefs } from '../displayPrefs';
import { AlbumFlowHeader } from './AlbumFlowHeader';
import { ArtistNameFirst, ArtistNameFirstSkeleton } from './ArtistNameFirst';
import { ArtistLikeAlbums, ArtistLikeAlbumsSkeleton } from './ArtistLikeAlbums';
import { detailsState, kindLine, pageSections, shelves as shelvesOf } from './artistPageView';
import { useArtistFlow } from './useArtistFlow';
import styles from './ArtistPage.module.css';

const NO_GLIDE = { x: 0, y: 0 };

export function ArtistPage() {
  const [maintenance, setMaintenance] = useMaintenance();
  const canCare = useCan('library.edit');
  const [{ artistLayout }] = useDisplayPrefs();
  const { libraryId } = useCurrentLibrary();
  const { artistId } = useParams({ from: '/layout/artists/$artistId' });
  const { data: artist, isLoading, error, waiting, restartPolling } = useArtist(libraryId, artistId);
  const followMutation = useFollowArtist(libraryId, artistId);
  const enrichMutation = useEnrichArtist(libraryId, artistId, restartPolling);
  const reopenMutation = useReopenGap(libraryId, artistId);
  const backAct = useContext(PageBackActionContext);

  const rootRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLHeadingElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const shelves = useMemo(() => shelvesOf(artist?.albums ?? []), [artist?.albums]);
  const nameFirst = artistLayout !== 'albums';
  const sections = useMemo(
    () => (artist && nameFirst ? pageSections(artist, shelves, maintenance) : []),
    [artist, nameFirst, shelves, maintenance],
  );
  const flow = useArtistFlow(rootRef, nameRef, sections.map((s) => s.id), endRef, !!artist);
  const [showReleaseTypes, setShowReleaseTypes] = useState(false);

  if (error) {
    return <PageShell back title="Couldn’t load this artist" barTitle={null}><p className={styles.error}>Failed to load artist</p></PageShell>;
  }

  const details = artist ? detailsState(artist, waiting) : 'fetching';
  const name = artist ? artistLabel(artist.name) : '';
  const headerLine = !artist || details === 'fetching' ? 'Artist' : kindLine(artist) || 'Artist';

  return (
    <PageShell bare>
      <div ref={rootRef} className={styles.page} data-artist-flow="" data-artist-layout={nameFirst ? 'name' : 'albums'}>
        <AlbumFlowHeader
          docked={flow.docked}
          artist={headerLine}
          title={name}
          glide={NO_GLIDE}
          backLabel={backAct?.label ?? null}
          onBack={() => backAct?.go()}
          onTop={flow.toTop}
          topLabel="Back to the top of the artist page"
          maintenance={maintenance}
          onToggleMaintenance={canCare ? () => setMaintenance(!maintenance) : undefined}
        />
        {isLoading || !artist
          ? (nameFirst ? <ArtistNameFirstSkeleton /> : <ArtistLikeAlbumsSkeleton />)
          : (() => {
            const props = {
              artist, shelves, details, maintenance, nameRef, endRef,
              follow: { pending: followMutation.isPending, toggle: () => followMutation.mutate(!artist.followed) },
              enrich: { pending: enrichMutation.isPending, run: () => enrichMutation.mutate() },
              onReleaseTypes: () => setShowReleaseTypes(true),
              onReopen: canCare ? (gapId: string) => reopenMutation.mutate(gapId) : undefined,
              reopening: reopenMutation.isPending,
              canFollow: canCare,
            };
            return nameFirst
              ? <ArtistNameFirst {...props} sections={sections} active={flow.active} goTo={flow.goTo} />
              : <ArtistLikeAlbums {...props} />;
          })()}
        {maintenance && showReleaseTypes && artist?.followed && (
          <ReleaseTypes libraryId={libraryId} artistId={artistId} onClose={() => setShowReleaseTypes(false)} />
        )}
      </div>
    </PageShell>
  );
}

const PRIMARY = ['Album', 'EP', 'Single'];
const SECONDARY = ['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Soundtrack'];

/** Which release types count as missing for this followed artist (per-artist follow rules, XO-347). */
function ReleaseTypes({ libraryId, artistId, onClose }: { libraryId: string | undefined; artistId: string; onClose: () => void }) {
  const { data: libraryRules } = useFollowRules(libraryId);
  const patch = usePatchArtistFollowRules(libraryId, artistId);
  const reset = useResetArtistFollowRules(libraryId, artistId);
  const [include, setInclude] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  // the library's rules until the artist detail carries its own
  useEffect(() => {
    if (!libraryRules) return;
    setInclude(libraryRules.includePrimary);
    setExclude(libraryRules.excludeSecondary);
  }, [libraryRules]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!libraryRules) return null;
  const toggle = (list: string[], set: (v: string[]) => void, t: string, on: boolean) => set(on ? [...list, t] : list.filter((x) => x !== t));
  return (
    <div className={styles.typesScrim} role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.typesDialog} role="dialog" aria-modal="true" aria-labelledby="release-types-title">
        <div className={styles.typesHeader}>
          <h3 id="release-types-title" className={styles.typesTitle}>Release types</h3>
          <IconButton variant="quiet" size="sm" label="Close" onClick={onClose}><span aria-hidden="true">✕</span></IconButton>
        </div>
        <fieldset className={styles.typesGroup}>
          <legend className={styles.label}>Count as missing</legend>
          {PRIMARY.map((t) => <label key={t} className={styles.check}>
            <input type="checkbox" checked={include.includes(t)} onChange={(e) => toggle(include, setInclude, t, e.target.checked)} />{t}
          </label>)}
        </fieldset>
        <fieldset className={styles.typesGroup}>
          <legend className={styles.label}>Leave out</legend>
          {SECONDARY.map((t) => <label key={t} className={styles.check}>
            <input type="checkbox" checked={exclude.includes(t)} onChange={(e) => toggle(exclude, setExclude, t, e.target.checked)} />{t}
          </label>)}
        </fieldset>
        <div className={styles.typesActions}>
          <Button variant="secondary" size="sm" disabled={reset.isPending} onClick={() => {
            reset.mutate();
            setInclude(libraryRules.includePrimary);
            setExclude(libraryRules.excludeSecondary);
          }}>Use library defaults</Button>
          <Button variant="primary" size="sm" disabled={patch.isPending} onClick={() => {
            patch.mutate({ includePrimary: include, excludeSecondary: exclude });
            onClose();
          }}>Save</Button>
        </div>
      </div>
    </div>
  );
}
