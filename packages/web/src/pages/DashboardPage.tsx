import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useAlbums, useCurrentLibrary, useIdentifyStats, useTagPlans } from '../hooks';
import { api } from '../services/api';
import { PageShell, Card, Button } from '../components/ui';
import styles from './DashboardPage.module.css';

export function DashboardPage() {
  const { libraryId, isLoading: libraryLoading } = useCurrentLibrary();
  const recent = useAlbums(libraryId, { limit: 6, sort: 'added_date' });
  const stats = useIdentifyStats(libraryId);
  const plans = useTagPlans(libraryId, { limit: 5 });
  const queue = useQuery({
    queryKey: ['queue-total', libraryId],
    queryFn: () => api.get<{ total?: number; items: unknown[] }>(`/libraries/${libraryId}/queue?limit=1`),
    enabled: !!libraryId,
  });
  const gaps = useQuery({
    queryKey: ['gaps-counts', libraryId],
    queryFn: () => api.get<{ counts: Record<string, number> }>(`/libraries/${libraryId}/gaps?limit=1`),
    enabled: !!libraryId,
  });
  const attentionCount = gaps.data ? ['duplicate', 'incomplete_album', 'missing_album'].reduce((n, key) => n + (gaps.data.counts[key] ?? 0), 0) : undefined;
  const careItems = [
    { label: 'Review matches', detail: 'Check suggested album matches', tab: 'review' as const, count: queue.data?.total },
    { label: 'Identify albums', detail: 'Find the right release for your music', tab: 'identify' as const, count: stats.data?.states.needsReview },
    { label: 'Resolve gaps', detail: 'Explore duplicates and incomplete albums', tab: 'attention' as const, count: attentionCount },
  ];

  return (
    <PageShell title="Your music, in good company." subtitle="Explore your collection. Make room for your next discovery." actions={<Link to="/albums" className={styles.browseLink}>Browse all albums <span aria-hidden="true">↗</span></Link>}>
      <div className={styles.content}>
        <section aria-labelledby="recent-heading">
          <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>At home in your library</p><h2 id="recent-heading">Recently added</h2></div><Link to="/albums" search={{ sort: 'added_date' }}>View all →</Link></div>
          {libraryLoading || recent.isLoading ? <div className={styles.albumGrid} aria-label="Loading recent albums" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className={styles.skeleton} />)}</div>
            : !libraryId ? <div className={styles.empty}><h3>Connect your music</h3><p>Set up a library to start exploring your albums.</p><Link to="/onboarding">Set up your library →</Link></div>
            : recent.isError ? <div className={styles.empty} role="alert"><h3>We couldn’t load your albums</h3><p>Your library is still here. Try loading it again.</p><Button variant="secondary" onClick={() => void recent.refetch()}>Try again</Button></div>
            : !recent.data?.items.length ? <div className={styles.empty}><h3>A home for every record</h3><p>Add a music folder and scan it to bring your albums into tagave.</p><Link to="/settings/library">Add a music folder →</Link></div>
            : <div className={styles.albumGrid}>{recent.data.items.map(album => <Link key={album.id} to="/albums/$albumId" params={{ albumId: album.id }} className={styles.album}>
              <div className={styles.artwork}>{album.coverUrl ? <img src={album.coverUrl} alt="" loading="lazy" /> : <span aria-hidden="true">♫</span>}</div>
              <h3>{album.title}</h3><p>{album.artistCredit}</p><span className={styles.year}>{album.year ?? 'Year unknown'}</span>
            </Link>)}</div>}
        </section>
        <div className={styles.lowerGrid}>
          <section aria-labelledby="care-heading"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>A little attention goes a long way</p><h2 id="care-heading">Care for your library</h2></div></div>
            <Card padded={false}><div className={styles.needsList}>{careItems.map(item => <Link key={item.tab} to="/work" search={{ tab: item.tab }} className={styles.needsItem}><div><h3>{item.label}</h3><p>{item.detail}</p></div><span className={styles.needsCount}>{item.count ?? '—'}</span><span aria-hidden="true">→</span></Link>)}</div></Card>
            {(queue.isError || stats.isError || gaps.isError) && <p className={styles.status} role="status">Some library counts are unavailable. <button className={styles.textButton} onClick={() => { void queue.refetch(); void stats.refetch(); void gaps.refetch(); }}>Retry</button></p>}
          </section>
          <section aria-labelledby="changes-heading"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Thoughtful upkeep</p><h2 id="changes-heading">Recent tag changes</h2></div><Link to="/plans">View all →</Link></div>
            {plans.isLoading ? <p className={styles.status}>Loading tag changes…</p> : plans.isError ? <p className={styles.status} role="alert">Couldn’t load tag changes. <button className={styles.textButton} onClick={() => void plans.refetch()}>Retry</button></p> : plans.data?.items.length ? <Card padded={false}><div className={styles.plansList}>{plans.data.items.map(plan => <Link key={plan.id} to="/plans/$planId" params={{ planId: plan.id }} className={styles.planItem}><span className={styles.planName}>{plan.name}</span><span className={styles.planState}>{plan.status.replace(/_/g, ' ')}</span></Link>)}</div></Card> : <div className={styles.quietEmpty}><h3>Everything in its right place</h3><p>Preview and apply metadata corrections here when your albums need them.</p><Link to="/plans">Explore tag changes →</Link></div>}
          </section>
        </div>
      </div>
    </PageShell>
  );
}
