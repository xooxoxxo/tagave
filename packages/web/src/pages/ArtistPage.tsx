/**
 * Artist detail page (spec BRW-3): canonical artist with enrichment state,
 * bio excerpt from Wikipedia, link chips, follow toggle, refresh button, and
 * discography grouped by release type.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { useCurrentLibrary, useArtist, useFollowArtist, useRefreshArtist } from '../hooks';
import styles from './ArtistPage.module.css';

export function ArtistPage() {
  const navigate = useNavigate();
  const { libraryId } = useCurrentLibrary();
  const { artistId } = useParams({ from: '/layout/artists/$artistId' });
  const { data: artist, isLoading, error, refetch } = useArtist(libraryId, artistId);
  const followMutation = useFollowArtist(libraryId, artistId);
  const refreshMutation = useRefreshArtist(libraryId, artistId);
  const [showRefreshNotification, setShowRefreshNotification] = useState(false);

  // Re-fetch artist data 1-2s after refresh completes
  useEffect(() => {
    if (refreshMutation.isSuccess) {
      const timeout = setTimeout(() => {
        refetch();
        setShowRefreshNotification(true);
        // Hide notification after 3 seconds
        setTimeout(() => setShowRefreshNotification(false), 3000);
      }, 1500);
      return () => clearTimeout(timeout);
    }
  }, [refreshMutation.isSuccess, refetch]);

  if (isLoading) {
    return <div className={styles.container}>Loading artist...</div>;
  }

  if (error || !artist) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>Failed to load artist</div>
      </div>
    );
  }

  const isEnriching = artist.enrichedAt === null;
  const isRefreshing = refreshMutation.isPending;

  return (
    <div className={styles.container}>
      {/* Header section */}
      <div className={styles.header}>
        <div className={styles.headInfo}>
          <div>
            <h1 className={styles.title}>{artist.name}</h1>
            {artist.sortName && artist.sortName !== artist.name && (
              <p className={styles.sortName}>{artist.sortName}</p>
            )}
          </div>

          {/* Meta: type, country, years */}
          <div className={styles.meta}>
            {artist.type && <span>{artist.type}</span>}
            {artist.country && <span>{artist.country}</span>}
            {(artist.beginDate || artist.endDate) && (
              <span>
                {artist.beginDate ? artist.beginDate.split('-')[0] : ''}
                {artist.beginDate && artist.endDate ? '–' : ''}
                {artist.endDate ? artist.endDate.split('-')[0] : ''}
              </span>
            )}
            {artist.disambiguation && (
              <span className={styles.disambiguation}>{artist.disambiguation}</span>
            )}
          </div>

          {/* Aliases */}
          {artist.aliases.length > 0 && (
            <div className={styles.aliases}>
              {artist.aliases.map((alias) => (
                <span key={alias} className={styles.aliasTag}>
                  {alias}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Enriching status, refresh button, and follow button */}
        <div className={styles.actions}>
          {isEnriching && <div className={styles.enriching}>Enriching…</div>}
          {isRefreshing && <div className={styles.refreshing}>Refreshing…</div>}
          {artist.followed && (
            <button
              className={styles.refreshButton}
              onClick={() => refreshMutation.mutate()}
              disabled={isRefreshing}
              title="Refresh discography from MusicBrainz"
            >
              {isRefreshing ? '⟳ Refreshing' : '⟳ Refresh'}
            </button>
          )}
          <button
            className={styles.followButton}
            onClick={() => followMutation.mutate(!artist.followed)}
            disabled={followMutation.isPending}
          >
            {artist.followed ? '✓ Following' : '+ Follow'}
          </button>
        </div>
      </div>

      {/* Bio section */}
      {artist.bio && (
        <div className={styles.bioSection}>
          <div className={styles.bioContent}>
            <p className={styles.bioText}>
              {artist.bio.text.length > 600
                ? `${artist.bio.text.substring(0, 600)}…`
                : artist.bio.text}
            </p>
            <div className={styles.bioLinks}>
              <a href={artist.bio.url} target="_blank" rel="noopener noreferrer" className={styles.bioLink}>
                Read on Wikipedia ↗
              </a>
              <span className={styles.bioLicense}>CC BY-SA 4.0</span>
            </div>
          </div>
        </div>
      )}

      {/* Link chips */}
      <div className={styles.links}>
        {artist.links.musicbrainz && (
          <a href={artist.links.musicbrainz} target="_blank" rel="noopener noreferrer" className={styles.linkChip}>
            MusicBrainz
          </a>
        )}
        {artist.links.discogs && (
          <a href={artist.links.discogs} target="_blank" rel="noopener noreferrer" className={styles.linkChip}>
            Discogs
          </a>
        )}
        {artist.links.wikidata && (
          <a href={artist.links.wikidata} target="_blank" rel="noopener noreferrer" className={styles.linkChip}>
            Wikidata
          </a>
        )}
        {artist.links.wikipedia && (
          <a href={artist.links.wikipedia} target="_blank" rel="noopener noreferrer" className={styles.linkChip}>
            Wikipedia
          </a>
        )}
      </div>

      {/* Discography sections */}
      <div className={styles.discography}>
        {artist.discography.length === 0 ? (
          <p className={styles.emptyDiscography}>No albums in library</p>
        ) : (
          artist.discography.map((section) => (
            <div key={section.type} className={styles.discographySection}>
              <h2 className={styles.discographyTitle}>{section.type}s</h2>
              <div className={styles.albumGrid}>
                {section.items.map((item) => (
                  <div
                    key={item.releaseGroupId}
                    className={styles.albumCard}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (item.localAlbumId) {
                        navigate({ to: `/albums/${item.localAlbumId}` });
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && item.localAlbumId) {
                        navigate({ to: `/albums/${item.localAlbumId}` });
                      }
                    }}
                  >
                    <div className={styles.coverContainer}>
                      {item.coverUrl ? (
                        <img src={item.coverUrl} alt={item.title} className={styles.cover} />
                      ) : (
                        <div className={styles.coverPlaceholder}>🎵</div>
                      )}
                      <div className={styles.ownership}>
                        {item.ownership === 'both' && <span>Digital & Physical</span>}
                        {item.ownership === 'digital' && <span>Digital</span>}
                        {item.ownership === 'physical' && <span>Physical</span>}
                      </div>
                    </div>
                    <div className={styles.cardInfo}>
                      <h3 className={styles.cardTitle}>{item.title}</h3>
                      {item.firstReleaseDate && (
                        <p className={styles.cardYear}>
                          {item.firstReleaseDate.split('-')[0]}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Refresh notification toast */}
      {showRefreshNotification && (
        <div className={styles.toast}>
          Discography updated
        </div>
      )}
    </div>
  );
}
