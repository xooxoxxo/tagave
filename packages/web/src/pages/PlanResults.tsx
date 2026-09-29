/**
 * The top of an applied plan's page: the albums its files make up now, each
 * linking to its album page and its artist, and one line on what was
 * written. While the worker is still re-reading the albums from the new tags
 * the section says so and keeps polling; the albums shown until then are the
 * ones from before.
 */
import { Link } from '@tanstack/react-router';
import type { TagPlanResultAlbum, TagPlanResults } from '@liner/shared';
import { plural } from './planOutcome';
import { resultsFilesLine, resultsHeadline } from './planResultsText';
import styles from './PlanResults.module.css';

function ArtistLink({ album }: { album: TagPlanResultAlbum }) {
  if (album.artistId) {
    return <Link className={styles.artist} to="/artists/$artistId" params={{ artistId: album.artistId }}>{album.artistCredit}</Link>;
  }
  // Known only from tags: the albums page filtered to the name, as the
  // artists list does for unlinked names.
  return <Link className={styles.artist} to="/albums" search={{ artist: album.artistCredit }}>{album.artistCredit}</Link>;
}

export function PlanResults({ results, loading }: { results: TagPlanResults | undefined; loading: boolean }) {
  if (!results) {
    return loading ? <section className={styles.results} aria-busy="true"><p className={styles.meta}>Loading the result…</p></section> : null;
  }
  return (
    <section className={styles.results} aria-labelledby="plan-results-title">
      <div className={styles.head}>
        <p className={styles.eyebrow}>Result</p>
        <h2 id="plan-results-title" className={styles.headline}>{resultsHeadline(results)}</h2>
        <p className={styles.meta}>
          {resultsFilesLine(results)}
          {results.updating && (
            <span className={styles.updating} role="status">
              <span className={styles.spinner} aria-hidden="true" />
              Updating albums from the new tags…
            </span>
          )}
        </p>
      </div>
      {results.albums.length > 0 && (
        <ul className={styles.albums}>
          {results.albums.map((a) => (
            <li key={a.id} className={styles.album}>
              <Link to="/albums/$albumId" params={{ albumId: a.id }} className={styles.cover} tabIndex={-1} aria-hidden="true">
                {a.coverUrl ? <img src={a.coverUrl} alt="" loading="lazy" /> : <span className={styles.coverBlank} />}
              </Link>
              <span className={styles.text}>
                <Link to="/albums/$albumId" params={{ albumId: a.id }} className={styles.title}>{a.title}</Link>
                <ArtistLink album={a} />
                <span className={styles.small}>
                  {[a.year, plural(a.trackCount, 'track'), a.planFiles !== a.trackCount ? `${a.planFiles.toLocaleString()} from this plan` : null]
                    .filter(Boolean).join(' · ')}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
