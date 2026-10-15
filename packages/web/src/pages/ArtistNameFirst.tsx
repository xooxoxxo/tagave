/**
 * The artist page, name first (the default; approved prototype direction B).
 *
 * A band with the name large, its kind, country and years above it and what
 * else it goes by under it; then two columns: a quiet column of facts that
 * is also the page's section navigation (it stays in view while the page
 * scrolls, and marks the section being read), and the sections themselves —
 * Biography, In your library, Not in your library (and Skipped, in
 * Maintenance). On one column (≤900px) the facts sit under the band and the
 * sections are a row that sticks under the header.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { ArtistDetail } from '../hooks';
import { artistLabel } from '@tagave/shared';
import { AlbumGrid, Bar, Biography, DetailsNote, FollowButton, ProviderLinks, SkeletonGrid, detailsWhen } from './ArtistParts';
import { Button } from '../components/ui';
import { kickerLine, ownedLine, SECTION_IDS, type ArtistShelves, type DetailsState, type PageSection } from './artistPageView';
import styles from './ArtistPage.module.css';

export interface ArtistLayoutProps {
  artist: ArtistDetail;
  shelves: ArtistShelves;
  details: DetailsState;
  maintenance: boolean;
  nameRef: RefObject<HTMLHeadingElement | null>;
  endRef: RefObject<HTMLDivElement | null>;
  follow: { pending: boolean; toggle: () => void };
  enrich: { pending: boolean; run: () => void };
  onReleaseTypes: () => void;
  onReopen: (gapId: string) => void;
  reopening: boolean;
}

export interface NameFirstProps extends ArtistLayoutProps {
  sections: PageSection[];
  active: string | null;
  goTo: (id: string) => void;
}

/** One link per section; the current one is marked (aria-current). */
function SectionLinks({ sections, active, goTo, className, label, followActive = false }: { sections: PageSection[]; active: string | null; goTo: (id: string) => void; className: string | undefined; label: string; followActive?: boolean }) {
  const list = useRef<HTMLUListElement>(null);
  // the row (one column) scrolls sideways to keep the current section in sight;
  // runs only when the current section changes, never per scroll frame
  useEffect(() => {
    const ul = list.current;
    if (!followActive || !ul || ul.scrollWidth <= ul.clientWidth) return;
    const a = ul.querySelector<HTMLElement>('[aria-current]');
    if (!a) return;
    const left = a.offsetLeft - ul.offsetLeft;
    if (left < ul.scrollLeft || left + a.offsetWidth > ul.scrollLeft + ul.clientWidth) {
      ul.scrollTo({ left: Math.max(0, left - 16), behavior: 'auto' });
    }
  }, [active, followActive]);
  return <nav className={className} aria-label={label}>
    <ul ref={list}>
      {sections.map((s) => <li key={s.id}>
        <a
          href={`#${s.id}`}
          aria-current={active === s.id ? 'location' : undefined}
          onClick={(e) => { e.preventDefault(); goTo(s.id); }}
        >
          <span>{s.label}</span>
          {s.count !== undefined && <small>{s.count}</small>}
        </a>
      </li>)}
    </ul>
  </nav>;
}

function Section({ id, title, count, children, className }: { id: string; title: string; count?: number; children: ReactNode; className?: string | undefined }) {
  const headingId = `${id}-h`;
  return <section id={id} className={`${styles.section} ${className ?? ''}`} aria-labelledby={headingId}>
    <h2 id={headingId} tabIndex={-1} className={styles.h2}>{title}{count !== undefined && <small>{count}</small>}</h2>
    {children}
  </section>;
}

export function ArtistNameFirst(p: NameFirstProps) {
  const { artist, shelves: s, details, maintenance } = p;
  const name = artistLabel(artist.name);
  const fetching = details === 'fetching';
  const kicker = fetching ? '' : kickerLine(artist);
  const sub: ReactNode[] = [];
  if (artist.disambiguation) sub.push(<span key="d">{artist.disambiguation}</span>);
  if (artist.aliases.length) sub.push(<span key="a">Also known as <em>{artist.aliases.join(', ')}</em></span>);
  const facts: Array<[string, string, boolean?]> = [['Owned', ownedLine(artist.owned)]];
  if (details === 'done' && !artist.bio) facts.push(['Biography', 'None on Wikipedia', true]);
  const showNav = p.sections.length > 1;

  return <div className={styles.B}>
    <section className={styles.band} aria-label="Artist">
      <div className={styles.bandText}>
        <p className={styles.kicker}>{kicker}</p>
        <h1 ref={p.nameRef} className={styles.bName} dir="auto">{name}</h1>
        {sub.length > 0 && <p className={styles.sub}>{sub.map((x, i) => <span key={i}>{i > 0 && '. '}{x}</span>)}</p>}
        <DetailsNote state={details} maintenance={maintenance} onRetry={p.enrich.run} retrying={p.enrich.pending} />
        <div className={styles.bandActs}>
          <FollowButton followed={artist.followed} pending={p.follow.pending} onToggle={p.follow.toggle} />
        </div>
      </div>
    </section>

    {showNav && <SectionLinks className={styles.strip} sections={p.sections} active={p.active} goTo={p.goTo} label="Sections" followActive />}

    <div className={styles.cols}>
      <aside className={styles.rail} aria-label={`About ${name}`}>
        <dl className={styles.facts}>
          {facts.map(([k, v, none]) => <div key={k} className={styles.row}><dt>{k}</dt><dd className={none ? styles.none : undefined}>{v}</dd></div>)}
        </dl>
        {showNav && <SectionLinks className={styles.toc} sections={p.sections} active={p.active} goTo={p.goTo} label="Sections" />}
        {maintenance && <div className={styles.railMaint}>
          <p className={styles.label}>Maintenance</p>
          <div className={styles.chips}><ProviderLinks links={artist.links} /></div>
          <div className={styles.maintBtns}>
            {artist.canEnrich && <Button variant="secondary" size="sm" onClick={p.enrich.run} loading={p.enrich.pending} disabled={fetching}>Refresh details</Button>}
            {artist.followed && <Button variant="secondary" size="sm" onClick={p.onReleaseTypes}>Release types</Button>}
          </div>
          <p className={styles.when}>{detailsWhen(artist, details)}</p>
        </div>}
      </aside>

      <div className={styles.mainCol}>
        {artist.bio && <Section id={SECTION_IDS.bio} title="Biography" className={styles.bio}>
          <Biography bio={artist.bio} headingId={`${SECTION_IDS.bio}-h`} />
        </Section>}
        {s.owned.length > 0
          ? <Section id={SECTION_IDS.owned} title="In your library" count={s.owned.length}><AlbumGrid albums={s.owned} /></Section>
          : <Section id={SECTION_IDS.owned} title="In your library"><p className={styles.empty}>Nothing by this artist on disk or on the shelf.</p></Section>}
        {s.missing.length > 0 && <Section id={SECTION_IDS.missing} title="Not in your library" count={s.missing.length}><AlbumGrid albums={s.missing} /></Section>}
        {maintenance && s.skipped.length > 0 && <Section id={SECTION_IDS.skipped} title="Skipped" count={s.skipped.length}>
          <AlbumGrid albums={s.skipped} onReopen={p.onReopen} reopening={p.reopening} />
        </Section>}
        <div ref={p.endRef} className={styles.end} aria-hidden="true" />
      </div>
    </div>
  </div>;
}

/** B while the artist loads: the band's lines and a grid of soft squares. */
export function ArtistNameFirstSkeleton() {
  return <div className={styles.B} aria-busy="true">
    <section className={styles.band} aria-label="Loading artist">
      <div className={styles.bandText}>
        <Bar width={140} />
        <div className={styles.skName} />
        <Bar width={280} height={16} className={styles.skSub} />
      </div>
    </section>
    <div className={styles.cols}>
      <aside className={styles.rail}>
        <dl className={styles.facts}>
          {[0, 1, 2, 3].map((i) => <div key={i} className={styles.row}><Bar width="40%" height={9} /><Bar /></div>)}
        </dl>
      </aside>
      <div className={styles.mainCol}>
        <div><Bar width={140} height={18} className={styles.skHead} /><SkeletonGrid n={8} /></div>
      </div>
    </div>
  </div>;
}
