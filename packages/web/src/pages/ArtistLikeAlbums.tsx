/**
 * The artist page laid out like an album page (Settings › Appearance ›
 * Artist page: Like albums; approved prototype direction A).
 *
 * A hero like the album's: up to four of the artist's covers as a mosaic
 * where the album has its cover, the kind and country above the name,
 * Follow, and the biography folded to about three lines (More, Less). Then
 * the albums (by kind, then what a followed artist is missing), Similar artists and About:
 * the trivia (what you own, years, other names, the biography's source, links).
 */
import type { ReactNode } from 'react';
import { artistLabel } from '@tagave/shared';
import { Button, CoverArt } from '../components/ui';
import { AlbumGrid, ArtistAbout, Bar, DetailsNote, FollowButton, ShortBio, SkeletonGrid, detailsWhen } from './ArtistParts';
import { LikeKey } from '../components/LikeKey';
import type { ArtistLayoutProps } from './ArtistNameFirst';
import { ALBUM_KINDS, KIND_HEADINGS, albumKind, hasAbout, kindLine, mosaicAlbums, ownedLine } from './artistPageView';
import type { ArtistAlbum } from '../hooks';
import { MissingHeadingMenu } from '../components/LidarrControls';
import { SimilarArtistsView, similarCount } from './SimilarArtists';
import styles from './ArtistPage.module.css';

function Mosaic({ albums, name }: { albums: ArtistAlbum[]; name: string }) {
  // no album yet: one placeholder square drawn from the name
  const shown = albums.length ? albums : [{ key: 'name', title: name, coverUrl: null } as ArtistAlbum];
  return <div className={styles.mosaic} data-n={shown.length} aria-hidden="true">
    {shown.map((a) => <CoverArt key={a.key} src={a.coverUrl} title={a.title} fill={false} className={styles.mosaicCover} />)}
  </div>;
}

function Group({ label, children, action }: { label: string | null; children: ReactNode; action?: ReactNode }) {
  return <div className={styles.aGroup}>
    {label && (action ? <div className={styles.headRow}><p className={styles.label}>{label}</p>{action}</div> : <p className={styles.label}>{label}</p>)}
    {children}
  </div>;
}

export function ArtistLikeAlbums(p: ArtistLayoutProps) {
  const { artist, shelves: s, details, maintenance } = p;
  const name = artistLabel(artist.name);
  const fetching = details === 'fetching';
  // albums by kind; headings only when there is more than one group to tell apart
  const byKind = new Map<string, ArtistAlbum[]>();
  for (const a of s.owned) {
    const k = albumKind(a);
    byKind.set(k, [...(byKind.get(k) ?? []), a]);
  }
  const groups = ALBUM_KINDS.filter((k) => byKind.has(k)).map((k) => [k, byKind.get(k)!] as const);
  const about = hasAbout(artist, details);
  const heads = groups.length > 1 || s.missing.length > 0 || (maintenance && s.skipped.length > 0) || about || !!p.similar;
  const similarN = p.similar ? similarCount(p.similar.view) : 0;

  return <div className={styles.A}>
    <section className={styles.hero} aria-label="Artist">
      <div className={styles.art}><Mosaic albums={mosaicAlbums(s.owned)} name={name} /></div>
      <div className={styles.info}>
        {fetching
          ? <DetailsNote state={details} maintenance={maintenance} onRetry={p.enrich.run} retrying={p.enrich.pending} compact />
          : <p className={styles.eyebrow}>{kindLine(artist)}</p>}
        <h1 ref={p.nameRef} className={styles.aName} dir="auto">{name}</h1>
        {details === 'failed' && <DetailsNote state={details} maintenance={maintenance} onRetry={p.enrich.run} retrying={p.enrich.pending} />}
        <div className={styles.acts}>
          {p.canFollow && <FollowButton followed={artist.followed} pending={p.follow.pending} onToggle={p.follow.toggle} />}
          <LikeKey kind="artist" id={artist.id} />
        </div>
      </div>
      {artist.bio && <ShortBio bio={artist.bio} className={styles.lede} />}
      {fetching && !artist.bio && <div className={styles.lede} aria-hidden="true"><Bar width="100%" /><Bar width="94%" /><Bar width="62%" /></div>}
    </section>

    {maintenance && <div className={styles.aMaint}>
      <span className={styles.label}>Maintenance</span>
      {artist.canEnrich && <Button variant="secondary" size="sm" onClick={p.enrich.run} loading={p.enrich.pending} disabled={fetching}>Refresh details</Button>}
      {artist.followed && <Button variant="secondary" size="sm" onClick={p.onReleaseTypes}>Release types</Button>}
      <span className={styles.aWhen}>{detailsWhen(artist, details)}</span>
    </div>}

    <div className={styles.aBody}>
      {groups.map(([k, list]) => <Group key={k} label={heads ? KIND_HEADINGS[k] : null}><AlbumGrid albums={list} artistOrigin={artist} /></Group>)}
      {s.owned.length === 0 && <p className={styles.empty}>Nothing in your library</p>}
      {s.missing.length > 0 && <Group label={`Not in your library · ${s.missing.length}`} action={<MissingHeadingMenu />}><AlbumGrid albums={s.missing} /></Group>}
      {maintenance && s.skipped.length > 0 && <Group label={`Skipped · ${s.skipped.length}`}>
        <AlbumGrid albums={s.skipped} onReopen={p.onReopen} reopening={p.reopening} />
      </Group>}
      {p.similar && <Group label={similarN > 0 ? `Similar artists · ${similarN}` : 'Similar artists'}><SimilarArtistsView {...p.similar} /></Group>}
      {about && <Group label="About"><ArtistAbout artist={artist} details={details} owned={ownedLine(artist.owned)} /></Group>}
      <div ref={p.endRef} aria-hidden="true" />
    </div>
  </div>;
}

/** A while the artist loads. */
export function ArtistLikeAlbumsSkeleton() {
  return <div className={styles.A} aria-busy="true">
    <section className={styles.hero} aria-label="Loading artist">
      <div className={styles.art}><div className={`${styles.mosaic} ${styles.skel}`} /></div>
      <div className={styles.info}>
        <Bar width={160} height={14} />
        <div className={styles.skName} />
        <div className={styles.acts}><Bar width={104} height={36} className={styles.skPill} /></div>
      </div>
      <div className={styles.lede}><Bar width="100%" /><Bar width="94%" /><Bar width="62%" /></div>
    </section>
    <div className={styles.aBody}><SkeletonGrid n={6} /></div>
  </div>;
}
