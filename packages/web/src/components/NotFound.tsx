/**
 * Not found, in the app frame: an unknown address (the router's catch-all)
 * and an album, plan or artist id the API answers 404 for. A title and one
 * link back — never "Loading…" for good, never a bare page.
 */
import { Link } from '@tanstack/react-router';
import { PageShell } from './ui';

const status = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null | undefined)?.status;
  return typeof s === 'number' ? s : undefined;
};

/** The API answered 404 for this query. */
export function isNotFound(err: unknown): boolean {
  return status(err) === 404;
}

/**
 * React Query retry rule: an answer the server meant (4xx: not found, not
 * allowed) is final, so the page shows it at once instead of after three
 * retries; server and network failures are retried up to three times.
 */
export function shouldRetryQuery(failureCount: number, err: unknown): boolean {
  const s = status(err);
  if (s !== undefined && s >= 400 && s < 500 && s !== 408 && s !== 429) return false;
  return failureCount < 3;
}

export function NotFoundPage({ title = 'Not found', to = '/', label = 'Back to Home' }: { title?: string; to?: string; label?: string }) {
  return (
    // `back`: a detail-page header, so the heading also shows on a phone
    // (a top-level page's heading is hidden there, and no route names this one)
    <PageShell title={title} back barTitle={null}>
      <p role="alert"><Link to={to}>{label}</Link></p>
    </PageShell>
  );
}
