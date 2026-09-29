/**
 * Artist detail page (spec BRW-3): canonical artist with enrichment state,
 * bio excerpt from Wikipedia, link chips, follow toggle, refresh button, and
 * discography grouped by release type with five-state ownership.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { useCurrentLibrary, useArtist, useFollowArtist, useRefreshArtist, useReopenGap, useFollowRules, usePatchArtistFollowRules, useResetArtistFollowRules, type ArtistDiscographyItem } from '../hooks';
import { PageShell, Button, IconButton, Badge, Card, CoverArt, CoverChip, UndoIcon, type CoverChipTone } from '../components/ui';
import styles from './ArtistPage.module.css';

const OWNERSHIP_LABEL: Record<ArtistDiscographyItem['ownership'], string> = {
  digital: 'Digital', physical: 'Physical', both: 'Digital & Physical', missing: 'Missing', ignored: 'Ignored',
};
const OWNERSHIP_CHIP_TONE: Record<ArtistDiscographyItem['ownership'], CoverChipTone> = {
  digital: 'neutral', physical: 'neutral', both: 'accent', missing: 'warn', ignored: 'neutral',
};

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
    return <PageShell title="Loading artist..." children={null} />;
  }

  if (error || !artist) {
    return <PageShell title="Error" children={<div className={styles.error}>Failed to load artist</div>} />;
  }

  const isEnriching = artist.enrichedAt === null;
  const isRefreshing = refreshMutation.isPending;

  const actions = (
    <div className={styles.actions}>
      {isEnriching && <div className={styles.enriching}>Enriching…</div>}
      {isRefreshing && <div className={styles.refreshing}>Refreshing…</div>}
      {artist.followed && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => refreshMutation.mutate()}
          disabled={isRefreshing}
          title="Refresh discography from MusicBrainz"
        >
          {isRefreshing ? '⟳ Refreshing' : '⟳ Refresh'}
        </Button>
      )}
      <Button
        variant="primary"
        size="sm"
        onClick={() => followMutation.mutate(!artist.followed)}
        disabled={followMutation.isPending}
      >
        {artist.followed ? '✓ Following' : '+ Follow'}
      </Button>
      {artist.followed && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowFollowRulesEditor(!showFollowRulesEditor)}
          title="Configure type filters for this artist"
        >
          ⚙ Type Filters
        </Button>
      )}
    </div>
  );

  const subtitle = (
    <div className={styles.subtitle}>
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
      {artist.sortName && artist.sortName !== artist.name && (
        <p className={styles.sortName}>{artist.sortName}</p>
      )}
    </div>
  );

  return (
    <PageShell
      title={artist.name}
      subtitle={subtitle}
      actions={actions}
    >
      <div className={styles.content}>
        {/* Aliases */}
        {artist.aliases.length > 0 && (
          <div className={styles.aliases}>
            {artist.aliases.map((alias) => (
              <Badge key={alias} tone="neutral">
                {alias}
              </Badge>
            ))}
          </div>
        )}

        {/* Bio section */}
        {artist.bio && (
          <Card title="Biography">
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
          </Card>
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

        {/* Follow rules editor modal */}
        {showFollowRulesEditor && artist.followed && libraryFollowRules && (
          <div className={styles.followRulesEditor}>
            <div className={styles.editorHeader}>
              <h3 className={styles.editorTitle}>Type Filters</h3>
              <IconButton
                variant="quiet"
                size="sm"
                label="Close"
                onClick={() => setShowFollowRulesEditor(false)}
              >
                <span aria-hidden="true">✕</span>
              </IconButton>
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
                <Button
                  variant="secondary"
                  onClick={() => {
                    resetArtistFollowRulesMutation.mutate();
                    setArtistIncludePrimary(libraryFollowRules.includePrimary);
                    setArtistExcludeSecondary(libraryFollowRules.excludeSecondary);
                  }}
                  disabled={resetArtistFollowRulesMutation.isPending}
                >
                  Reset to Defaults
                </Button>
                <Button
                  variant="primary"
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
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Discography sections */}
        {artist.discography.length === 0 ? (
          <p className={styles.emptyDiscography}>No albums in library</p>
        ) : (
          <div className={styles.discography}>
            <div className={styles.ownershipLegend}>
              {(['digital', 'physical', 'both', 'missing', 'ignored'] as const).map((ownership) => {
                const labels = {
                  digital: 'Digital',
                  physical: 'Physical',
                  both: 'Digital & Physical',
                  missing: 'Missing',
                  ignored: 'Ignored',
                };
                const tones = {
                  digital: 'neutral',
                  physical: 'neutral',
                  both: 'accent',
                  missing: 'warning',
                  ignored: 'neutral',
                } as const;
                return (
                  <div key={ownership} className={styles.legendItem}>
                    <Badge tone={tones[ownership]}>{labels[ownership]}</Badge>
                  </div>
                );
              })}
            </div>

            {artist.discography.map((section) => (
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
                      <CoverArt
                        src={item.coverUrl}
                        title={item.title}
                        dimmed={item.ownership === 'missing' || item.ownership === 'ignored' ? item.ownership : undefined}
                      >
                        <CoverChip tone={OWNERSHIP_CHIP_TONE[item.ownership]}>{OWNERSHIP_LABEL[item.ownership]}</CoverChip>
                        {item.ownership === 'ignored' && item.gapId && (
                          <IconButton
                            size="sm"
                            label={`Reopen (dismissed: ${item.dismissReason || 'no reason'})`}
                            onClick={(e) => {
                              e.stopPropagation();
                              reopenMutation.mutate(item.gapId!);
                            }}
                            disabled={reopenMutation.isPending}
                            className={styles.reopenButton}
                          >
                            <UndoIcon />
                          </IconButton>
                        )}
                      </CoverArt>
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
            ))}
          </div>
        )}

        {/* Refresh notification toast */}
        {showRefreshNotification && (
          <div className={styles.toast}>
            Discography updated
          </div>
        )}
      </div>
    </PageShell>
  );
}
