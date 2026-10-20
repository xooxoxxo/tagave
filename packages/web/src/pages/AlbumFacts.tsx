/**
 * The album's About facts: a label and its value per row ("Released",
 * "Genres & styles", "Local folder" with its actions). Side by side with
 * room, stacked on a phone (AlbumDetailPage.module.css `.facts`). Shared by
 * the page's About tab and the Album info drawer, and rendered whole in
 * Storybook so a layout change shows up in the screenshot baselines.
 *
 * Where the data came from ends the list as one small line: Discogs' API
 * terms ask for "Data provided by Discogs" wherever its data is shown, and
 * the MusicBrainz release is a link (CC0, no credit owed). It lives here,
 * not at the foot of the album page (owner, 2026-10-20: "we don't want
 * distractions").
 */
import type { ReactNode } from 'react';
import styles from './AlbumDetailPage.module.css';

export type AlbumFact = [label: string, value: ReactNode];

export interface AlbumSource {
  /** some of what is shown came from Discogs */
  discogs?: boolean;
  /** the MusicBrainz release, linked */
  mbid?: string | null | undefined;
}

export function AlbumFacts({ facts, source }: { facts: AlbumFact[]; source?: AlbumSource }) {
  const links: ReactNode[] = [];
  if (source?.discogs) links.push(<a key="discogs" href="https://www.discogs.com" target="_blank" rel="noopener noreferrer">Data provided by Discogs</a>);
  if (source?.mbid) links.push(<a key="mb" href={`https://musicbrainz.org/release/${source.mbid}`} target="_blank" rel="noopener noreferrer">MusicBrainz</a>);
  return (
    <>
      <dl className={styles.facts}>
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {links.length > 0 && (
        <p className={styles.attribution} data-album-source="">
          {links.flatMap((l, i) => (i ? [<span key={`s${i}`} aria-hidden="true"> · </span>, l] : [l]))}
        </p>
      )}
    </>
  );
}
