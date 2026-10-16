/**
 * The artist page laid out like an album page (Settings › Appearance ›
 * Artist page: Like albums; approved prototype direction A).
 *
 * A hero like the album's: up to four of the artist's covers as a mosaic
 * where the album has its cover, the kind and country above the name, the
 * facts in a row, Follow, and the biography's opening lines. Then tabs —
 * Albums (by kind, then what a followed artist is missing) and Biography.
 */
import { useState, type ReactNode } from 'react';
import { artistLabel } from '@tagave/shared';
import { Button, CoverArt, Tabs, type TabItem } from '../components/ui';
import { AlbumGrid, Bar, BioSource, DetailsNote, FollowButton, ProviderLinks, SkeletonGrid, detailsWhen } from './ArtistParts';
import type { ArtistLayoutProps } from './ArtistNameFirst';
import { ALBUM_KINDS, KIND_HEADINGS, albumKind, kindLine, mosaicAlbums, ownedLine, paragraphs, regionName, yearsLine } from './artistPageView';
import type { ArtistAlbum } from '../hooks';
import styles from './ArtistPage.module.css';

function Mosaic({ albums, name }: { albums: ArtistAlbum[]; name: string }) {
  // no album yet: one placeholder square drawn from the name
  const shown = albums.length ? albums : [{ key: 'name', title: name, coverUrl: null } as ArtistAlbum];
  return <div className={styles.mosaic} data-n={shown.length} aria-hidden="true">
    {shown.map((a) => <CoverArt key={a.key} src={a.coverUrl} title={a.title} fill={false} className={styles.mosaicCover} />)}
  </div>;
}

function Group({ label, children }: { label: string | null; children: ReactNode }) {
  return <div className={styles.aGroup}>
    {label && <p className={styles.label}>{label}</p>}
    {children}
  </div>;
}

export function ArtistLikeAlbums(p: ArtistLayoutProps) {
  const { artist, shelves: s, details, maintenance } = p;
  const name = artistLabel(artist.name);
  const fetching = details === 'fetching';
  const [tab, setTab] = useState<'albums' | 'bio'>('albums');

  const facts: Array<[string, ReactNode, boolean?]> = [];
  if (fetching) {
    facts.push(['From', <Bar key="b" />], ['Active', <Bar key="b" />], ['Also known as', <Bar key="b" />]);
    facts.push(['In your library', ownedLine(artist.owned)]);
  } else {
    const from = regionName(artist.country);
    const years = yearsLine(artist);
    if (from) facts.push(['From', from]);
    // a group's active years; a person's birth (or life)
    if (years) facts.push([artist.type === 'Person' ? (artist.endDate ? 'Lived' : 'Born') : 'Active', years.replace(/^Born /, '')]);
    if (artist.aliases.length) facts.push(['Also known as', artist.aliases.join(', ')]);
    facts.push(['In your library', ownedLine(artist.owned)]);
    if (details === 'done' && !artist.bio) facts.push(['Biography', 'None on Wikipedia', true]);
  }

  // albums by kind; headings only when there is more than one group to tell apart
  const byKind = new Map<string, ArtistAlbum[]>();
  for (const a of s.owned) {
    const k = albumKind(a);
    byKind.set(k, [...(byKind.get(k) ?? []), a]);
  }
  const groups = ALBUM_KINDS.filter((k) => byKind.has(k)).map((k) => [k, byKind.get(k)!] as const);
  const heads = groups.length > 1 || s.missing.length > 0 || (maintenance && s.skipped.length > 0);
  const lede = artist.bio ? paragraphs(artist.bio.text)[0] : null;

  const tabs: TabItem[] = [{ value: 'albums', label: 'Albums', count: s.owned.length }];
  if (artist.bio) tabs.push({ value: 'bio', label: 'Biography' });

  return <div className={styles.A}>
    <section className={styles.hero} aria-label="Artist">
      <div className={styles.art}><Mosaic albums={mosaicAlbums(s.owned)} name={name} /></div>
      <div className={styles.info}>
        {fetching
          ? <DetailsNote state={details} maintenance={maintenance} onRetry={p.enrich.run} retrying={p.enrich.pending} compact />
          : <p className={styles.eyebrow}>{kindLine(artist)}</p>}
        <h1 ref={p.nameRef} className={styles.aName} dir="auto">{name}</h1>
        {artist.disambiguation && !fetching && <p className={styles.dis}>{artist.disambiguation}</p>}
        {details === 'failed' && <DetailsNote state={details} maintenance={maintenance} onRetry={p.enrich.run} retrying={p.enrich.pending} />}
        <dl className={styles.aFacts}>
          {facts.map(([k, v, none]) => <div key={k}><dt>{k}</dt><dd className={none ? styles.none : undefined}>{v}</dd></div>)}
        </dl>
        <div className={styles.acts}>
          {p.canFollow && <FollowButton followed={artist.followed} pending={p.follow.pending} onToggle={p.follow.toggle} />}
        </div>
      </div>
      {lede && <div className={styles.lede}>
        <p>{lede}</p>
        <div className={styles.ledeSrc}>
          <button type="button" className={styles.textLink} onClick={() => setTab('bio')}>Read more</button>
          <span>Wikipedia · {artist.bio!.license || 'CC BY-SA 4.0'}</span>
        </div>
      </div>}
      {fetching && !lede && <div className={styles.lede} aria-hidden="true"><Bar width="100%" /><Bar width="94%" /><Bar width="62%" /></div>}
    </section>

    {maintenance && <div className={styles.aMaint}>
      <span className={styles.label}>Maintenance</span>
      <ProviderLinks links={artist.links} />
      {artist.canEnrich && <Button variant="secondary" size="sm" onClick={p.enrich.run} loading={p.enrich.pending} disabled={fetching}>Refresh details</Button>}
      {artist.followed && <Button variant="secondary" size="sm" onClick={p.onReleaseTypes}>Release types</Button>}
      <span className={styles.aWhen}>{detailsWhen(artist, details)}</span>
    </div>}

    <div className={styles.sect}>
      <Tabs items={tabs} value={tab} onChange={(v) => setTab(v as 'albums' | 'bio')} label="Artist sections" />
    </div>

    <div className={styles.aBody}>
      {tab === 'bio' && artist.bio
        ? <div className={styles.bioFull}>
          {paragraphs(artist.bio.text).map((t, i) => <p key={i}>{t}</p>)}
          <p className={styles.bioSource}><BioSource bio={artist.bio} /></p>
        </div>
        : <>
          {groups.map(([k, list]) => <Group key={k} label={heads ? KIND_HEADINGS[k] : null}><AlbumGrid albums={list} /></Group>)}
          {s.owned.length === 0 && <p className={styles.empty}>Nothing by this artist on disk or on the shelf.</p>}
          {s.missing.length > 0 && <Group label={`Not in your library · ${s.missing.length}`}><AlbumGrid albums={s.missing} /></Group>}
          {maintenance && s.skipped.length > 0 && <Group label={`Skipped · ${s.skipped.length}`}>
            <AlbumGrid albums={s.skipped} onReopen={p.onReopen} reopening={p.reopening} />
          </Group>}
        </>}
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
        <dl className={styles.aFacts}>
          {['From', 'Active', 'In your library'].map((k) => <div key={k}><dt>{k}</dt><dd><Bar /></dd></div>)}
        </dl>
        <div className={styles.acts}><Bar width={104} height={36} className={styles.skPill} /></div>
      </div>
      <div className={styles.lede}><Bar width="100%" /><Bar width="94%" /><Bar width="62%" /></div>
    </section>
    <div className={styles.sect}><div className={`${styles.skTabs} ${styles.skel}`} /></div>
    <div className={styles.aBody}><SkeletonGrid n={6} /></div>
  </div>;
}
