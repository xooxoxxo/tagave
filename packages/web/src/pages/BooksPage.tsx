/**
 * Books (the books app, the spike; behind TAGAVE_DEV_APPS): the works of the
 * books library, read-only, as the album and playlist grids: the cover, the
 * title and the authors under it. Labels and values only.
 */
import type { BookWorkView } from '@tagave/shared';
import { CoverArt, EmptyState, PageShell } from '../components/ui';
import { useAppOn } from '../hooks/useFacets';
import { bookCoverUrl, useBooks } from '../hooks/useBooks';
import styles from './BooksPage.module.css';

/** The grid alone (tests). */
export function BooksGrid({ works }: { works: readonly BookWorkView[] }) {
  return (
    <ul className={styles.grid}>
      {works.map((w) => (
        <li key={w.id} className={styles.tile}>
          <CoverArt src={w.coverEditionId ? bookCoverUrl(w.coverEditionId) : null} title={w.title} className={styles.tileCover} loading="lazy" />
          <span className={styles.tileName} dir="auto">{w.title}</span>
          {w.authors.length > 0 && <span className={styles.tileMeta} dir="auto">{w.authors.join(', ')}</span>}
        </li>
      ))}
    </ul>
  );
}

export function BooksPage() {
  const known = useAppOn('books');
  const works = useBooks();
  if (known === false) return <PageShell title="Books"><EmptyState title="Books is off" /></PageShell>;
  return (
    <PageShell title="Books">
      {works.isLoading || known === null ? null : (works.data?.length ?? 0) === 0 ? (
        <EmptyState title="No books" />
      ) : (
        <BooksGrid works={works.data ?? []} />
      )}
    </PageShell>
  );
}
