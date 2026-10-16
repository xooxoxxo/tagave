import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useAlbums, useCan, useCurrentLibrary, useGapCounts, useIdentifyStats, useTagPlans } from '../hooks';
import { usePlaybackAvailable } from '../hooks/usePlayer';
import { playAlbum } from '../player/engine';
import { api } from '../services/api';
import { PageShell, Card, Button, LinkButton, CoverArt } from '../components/ui';
import styles from './DashboardPage.module.css';

export function DashboardPage() {
  const { libraryId, isLoading: libraryLoading } = useCurrentLibrary();
  const recent = useAlbums(libraryId, { limit: 6, sort: 'added_date' });
  // Library care is an editor's and owner's: a listener's Home is the music
  // and the player, and none of the care counts are asked for.
  const canCare = useCan('library.edit');
  const careLibrary = canCare ? libraryId : undefined;
  const canPlay = usePlaybackAvailable();
  const stats = useIdentifyStats(careLibrary);
  const plans = useTagPlans(careLibrary, { limit: 5 });
  const queue = useQuery({
    queryKey: ['queue-total', libraryId],
    queryFn: () => api.get<{ total?: number; items: unknown[] }>(`/libraries/${libraryId}/queue?limit=1`),
    enabled: !!careLibrary,
  });
  // the same cached query the nav badge uses: one request, not two
  const gaps = useGapCounts(careLibrary);
  const playable = recent.data?.items ?? [];
  const playRecent = () => {
    const album = playable[Math.floor(Math.random() * playable.length)];
    if (album) void playAlbum({ albumId: album.id, title: album.title, artist: album.artistCredit ?? 'Unknown artist', coverUrl: album.coverUrl ?? null });
  };
  const attentionCount = gaps.data ? ['duplicate', 'incomplete_album', 'missing_album'].reduce((n, key) => n + (gaps.data.counts[key] ?? 0), 0) : undefined;
  const careItems = [
    { label: 'Review matches', detail: 'Check suggested album matches', tab: 'review' as const, count: queue.data?.total },
    { label: 'Identify albums', detail: 'Find the right release for your music', tab: 'identify' as const, count: stats.data?.states.needsReview },
    { label: 'Resolve gaps', detail: 'Explore duplicates and incomplete albums', tab: 'attention' as const, count: attentionCount },
  ];

  return (
    <PageShell
      title="Home"
      actions={<>
        {!canCare && canPlay && playable.length > 0 && <Button onClick={playRecent}>Play a recent album</Button>}
        <LinkButton to="/albums" variant={!canCare && canPlay && playable.length > 0 ? 'secondary' : 'primary'}>Browse all albums <span aria-hidden="true">↗</span></LinkButton>
      </>}
    >
      {/* A kiosk view on a desktop: the page is exactly the height of the
          window and the recently added row sizes its covers to the room left
          (DashboardPage.module.css); on a phone it scrolls naturally. */}
      <div className={styles.content} data-kiosk-page>
        <section aria-labelledby="recent-heading" className={styles.recent}>
          <div className={styles.sectionHeading}><div><h2 id="recent-heading">Recently added</h2></div><Link to="/albums" search={{ sort: 'added_date' }}>View all →</Link></div>
          {libraryLoading || recent.isLoading ? <div className={styles.albumGrid} aria-label="Loading recent albums" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className={styles.skeleton} />)}</div>
            : !libraryId ? <div className={styles.empty}><h3>Connect your music</h3><p>Set up a library to start exploring your albums.</p><Link to="/onboarding">Set up your library →</Link></div>
            : recent.isError ? <div className={styles.empty} role="alert"><h3>We couldn’t load your albums</h3><p>Your library is still here. Try loading it again.</p><Button variant="secondary" onClick={() => void recent.refetch()}>Try again</Button></div>
            : !recent.data?.items.length ? <div className={styles.empty}><h3>No albums yet</h3>{canCare ? <><p>Add a music folder and scan it.</p><Link to="/settings/library">Add a music folder →</Link></> : <p>Albums appear here once the owner adds a music folder.</p>}</div>
            : <div className={styles.stage}><div className={styles.albumGrid}>{recent.data.items.map(album => <Link key={album.id} to="/albums/$albumId" params={{ albumId: album.id }} className={styles.album}>
              <CoverArt src={album.coverUrl} title={album.title} className={styles.artwork} interactive />
              {/* dir="auto": a title in a right-to-left script (or mis-decoded
                  tags that came out as one) keeps its own direction instead of
                  being reordered around the Latin text */}
              <h3 dir="auto" title={album.title}>{album.title}</h3><p dir="auto">{album.artistCredit}</p><span className={styles.year}>{album.year ?? 'Year unknown'}</span>
            </Link>)}</div></div>}
        </section>
        {canCare && <div className={styles.lowerGrid}>
          <section aria-labelledby="care-heading"><div className={styles.sectionHeading}><div><h2 id="care-heading">Care for your library</h2></div></div>
            <Card padded={false}><div className={styles.needsList}>{careItems.map(item => <Link key={item.tab} to="/work" search={{ tab: item.tab }} className={styles.needsItem}><div><h3>{item.label}</h3><p>{item.detail}</p></div><span className={styles.needsCount}>{item.count ?? '—'}</span><span aria-hidden="true">→</span></Link>)}</div></Card>
            {(queue.isError || stats.isError || gaps.isError) && <p className={styles.status} role="status">Some library counts are unavailable. <Button variant="quiet" size="sm" onClick={() => { void queue.refetch(); void stats.refetch(); void gaps.refetch(); }}>Retry</Button></p>}
          </section>
          <section aria-labelledby="changes-heading"><div className={styles.sectionHeading}><div><h2 id="changes-heading">Recent tag changes</h2></div><Link to="/plans">View all →</Link></div>
            {plans.isLoading ? <p className={styles.status}>Loading tag changes…</p> : plans.isError ? <p className={styles.status} role="alert">Couldn’t load tag changes. <Button variant="quiet" size="sm" onClick={() => void plans.refetch()}>Retry</Button></p> : plans.data?.items.length ? <Card padded={false}><div className={styles.plansList}>{plans.data.items.map(plan => <Link key={plan.id} to="/plans/$planId" params={{ planId: plan.id }} className={styles.planItem}><span className={styles.planName} dir="auto">{plan.name}</span><span className={styles.planState}>{plan.status.replace(/_/g, ' ')}</span></Link>)}</div></Card> : <div className={styles.quietEmpty}><h3>No tag changes yet</h3><Link to="/plans">Explore tag changes →</Link></div>}
          </section>
        </div>}
      </div>
    </PageShell>
  );
}
