/**
 * Artist detail page (spec BRW-3): canonical artist with enrichment state,
 * bio excerpt from Wikipedia, link chips, follow toggle, refresh button, and
 * discography grouped by release type with five-state ownership.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { useCurrentLibrary, useArtist, useFollowArtist, useRefreshArtist, useReopenGap, useFollowRules, usePatchArtistFollowRules, useResetArtistFollowRules } from '../hooks';
import styles from './ArtistPage.module.css';

export function ArtistPage() {
  const navigate = useNavigate();
  const { libraryId } = useCurrentLibrary();
  const { artistId } = useParams({ from: '/layout/artists/$artistId' });
  const { data: artist, isLoading, error, refetch } = useArtist(libraryId, artistId);
  const followMutation = useFollowArtist(libraryId, artistId);
  const refreshMutation = useRefreshArtist(libraryId, artistId);
  const reopenMutation = useReopenGap(libraryId, artistId);
  const [showRefreshNotification, setShowRefreshNotification] = useState(false);
  const [showFollowRulesEditor, setShowFollowRulesEditor] = useState(false);
  const { data: libraryFollowRules } = useFollowRules(libraryId);
  const patchArtistFollowRulesMutation = usePatchArtistFollowRules(libraryId, artistId);
  const resetArtistFollowRulesMutation = useResetArtistFollowRules(libraryId, artistId);
  const [artistIncludePrimary, setArtistIncludePrimary] = useState<string[]>([]);
  const [artistExcludeSecondary, setArtistExcludeSecondary] = useState<string[]>([]);

  // Initialize artist follow rules from data
  useEffect(() => {
    if (artist?.followed) {
      // For now, we'll show library defaults until we can fetch per-artist rules
      // When GET artist detail includes follow rules, we'll use those
      if (libraryFollowRules) {
        setArtistIncludePrimary(libraryFollowRules.includePrimary);
        setArtistExcludeSecondary(libraryFollowRules.excludeSecondary);
      }
    }
  }, [artist?.followed, libraryFollowRules]);

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
          {artist.followed && (
            <button
              className={styles.settingsButton}
              onClick={() => setShowFollowRulesEditor(!showFollowRulesEditor)}
              title="Configure type filters for this artist"
            >
              ⚙ Type Filters
            </button>
          )}
        </div>
      </div>

      {/* Follow rules editor modal */}
      {showFollowRulesEditor && artist.followed && libraryFollowRules && (
        <div className={styles.followRulesEditor}>
          <div className={styles.editorHeader}>
            <h3 className={styles.editorTitle}>Type Filters</h3>
            <button
              className={styles.closeButton}
              onClick={() => setShowFollowRulesEditor(false)}
              title="Close"
            >
              ✕
            </button>
          </div>

          <div className={styles.editorContent}>
            <div className={styles.rulesSection}>
              <h4 className={styles.sectionLabel}>Include Primary Types</h4>
              <div className={styles.typeOptions}>
                {['Album', 'EP', 'Single'].map((type) => (
                  <label key={type} className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={artistIncludePrimary.includes(type)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setArtistIncludePrimary([...artistIncludePrimary, type]);
                        } else {
                          setArtistIncludePrimary(artistIncludePrimary.filter((t) => t !== type));
                        }
                      }}
                    />
                    {type}
                  </label>
                ))}
              </div>
            </div>

            <div className={styles.rulesSection}>
              <h4 className={styles.sectionLabel}>Exclude Secondary Types</h4>
              <div className={styles.typeOptions}>
                {['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Soundtrack'].map((type) => (
                  <label key={type} className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={artistExcludeSecondary.includes(type)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setArtistExcludeSecondary([...artistExcludeSecondary, type]);
                        } else {
                          setArtistExcludeSecondary(artistExcludeSecondary.filter((t) => t !== type));
                        }
                      }}
                    />
                    {type}
                  </label>
                ))}
              </div>
            </div>

            <div className={styles.editorActions}>
              <button
                className={styles.resetButton}
                onClick={() => {
                  resetArtistFollowRulesMutation.mutate();
                  setArtistIncludePrimary(libraryFollowRules.includePrimary);
                  setArtistExcludeSecondary(libraryFollowRules.excludeSecondary);
                }}
                disabled={resetArtistFollowRulesMutation.isPending}
              >
                Reset to Defaults
              </button>
              <button
                className={styles.saveButton}
                onClick={() => {
                  patchArtistFollowRulesMutation.mutate({
                    includePrimary: artistIncludePrimary,
                    excludeSecondary: artistExcludeSecondary,
                  });
                  setShowFollowRulesEditor(false);
                }}
                disabled={patchArtistFollowRulesMutation.isPending}
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

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
        {/* Five-state ownership legend */}
        <div className={styles.ownershipLegend}>
          <div className={styles.legendItem}>
            <span className={`${styles.stateChip} ${styles.digitalChip}`}>Digital</span>
          </div>
          <div className={styles.legendItem}>
            <span className={`${styles.stateChip} ${styles.physicalChip}`}>Physical</span>
          </div>
          <div className={styles.legendItem}>
            <span className={`${styles.stateChip} ${styles.bothChip}`}>Both</span>
          </div>
          <div className={styles.legendItem}>
            <span className={`${styles.stateChip} ${styles.missingChip}`}>Missing</span>
          </div>
          <div className={styles.legendItem}>
            <span className={`${styles.stateChip} ${styles.ignoredChip}`}>Ignored</span>
          </div>
        </div>

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
                    className={`${styles.albumCard} ${item.ownership === 'missing' ? styles.missingItem : ''} ${item.ownership === 'ignored' ? styles.ignoredItem : ''}`}
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
                      <div className={`${styles.ownership} ${item.ownership === 'missing' ? styles.ownershipMissing : ''} ${item.ownership === 'ignored' ? styles.ownershipIgnored : ''}`}>
                        <div className={styles.stateChipContainer}>
                          <span
                            className={`${styles.stateChip} ${
                              item.ownership === 'digital'
                                ? styles.digitalChip
                                : item.ownership === 'physical'
                                  ? styles.physicalChip
                                  : item.ownership === 'both'
                                    ? styles.bothChip
                                    : item.ownership === 'missing'
                                      ? styles.missingChip
                                      : item.ownership === 'ignored'
                                        ? styles.ignoredChip
                                        : ''
                            }`}
                          >
                            {item.ownership === 'both' && 'Digital & Physical'}
                            {item.ownership === 'digital' && 'Digital'}
                            {item.ownership === 'physical' && 'Physical'}
                            {item.ownership === 'missing' && 'Missing'}
                            {item.ownership === 'ignored' && 'Ignored'}
                          </span>
                          {item.ownership === 'ignored' && item.gapId && (
                            <button
                              className={styles.reopenButton}
                              onClick={(e) => {
                                e.stopPropagation();
                                reopenMutation.mutate(item.gapId!);
                              }}
                              disabled={reopenMutation.isPending}
                              title={`Dismissed: ${item.dismissReason || 'No reason'}`}
                            >
                              ↻
                            </button>
                          )}
                        </div>
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
