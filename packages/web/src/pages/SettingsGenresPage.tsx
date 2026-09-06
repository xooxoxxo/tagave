/**
 * Settings › Genres page (spec XO-310 §7): genre whitelist, aliases, max genres, and preview
 */
import { useEffect, useState } from 'react';
import { useCurrentLibrary } from '../hooks';
import { useGenreMap, usePatchGenreMap, useGenrePreview, type GenreMap } from '../hooks/useArtists';
import { SettingsNav } from '../components/SettingsNav';
import styles from './SettingsGenresPage.module.css';

export function SettingsGenresPage() {
  const { libraryId } = useCurrentLibrary();
  const { data: currentMap, isLoading: mapLoading } = useGenreMap(libraryId);
  const { data: previewData, isLoading: previewLoading } = useGenrePreview(libraryId);
  const patchGenreMap = usePatchGenreMap(libraryId);

  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [whitelistText, setWhitelistText] = useState('');
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [aliasesText, setAliasesText] = useState('');
  const [maxGenres, setMaxGenres] = useState(3);
  const [ignoredLines, setIgnoredLines] = useState({ aliases: 0 });
  const [savedMap, setSavedMap] = useState<GenreMap | null>(null);

  // Initialize fields when settings arrive
  useEffect(() => {
    if (currentMap) {
      setWhitelist(currentMap.whitelist);
      setWhitelistText(currentMap.whitelist.join('\n'));
      setAliases(currentMap.aliases);
      setSavedMap(currentMap);
      setMaxGenres(currentMap.maxGenres);

      // Populate aliases textarea
      const aliasLines = Object.entries(currentMap.aliases)
        .map(([from, to]) => `${from} = ${to}`)
        .join('\n');
      setAliasesText(aliasLines);
    }
  }, [currentMap]);

  const parseAliases = (text: string): { parsed: Record<string, string>; ignored: number } => {
    const parsed: Record<string, string> = {};
    let ignored = 0;

    text.split('\n').forEach((line) => {
      const trimmed = line.trim();
      // Skip blank lines
      if (!trimmed) return;

      const match = trimmed.match(/^(.+?)\s*=\s*(.+)$/);
      if (!match) {
        ignored += 1;
        return;
      }

      const from = match[1]!.trim().toLowerCase();
      const to = match[2]!.trim();

      // Validate that 'from' and 'to' are non-empty
      if (!from || !to) {
        ignored += 1;
        return;
      }

      parsed[from] = to;
    });

    return { parsed, ignored };
  };

  const handleAliasesChange = (text: string) => {
    setAliasesText(text);
    const { parsed, ignored } = parseAliases(text);
    setAliases(parsed);
    setIgnoredLines({ aliases: ignored });
  };

  const handleSave = async () => {
    const newMap: GenreMap = {
      whitelist,
      aliases,
      maxGenres,
    };

    await patchGenreMap.mutateAsync(newMap);
    setSavedMap(newMap);
  };

  const handleReset = () => {
    if (savedMap) {
      setWhitelist(savedMap.whitelist);
      setWhitelistText(savedMap.whitelist.join('\n'));
      setAliases(savedMap.aliases);
      setMaxGenres(savedMap.maxGenres);

      const aliasLines = Object.entries(savedMap.aliases)
        .map(([from, to]) => `${from} = ${to}`)
        .join('\n');
      setAliasesText(aliasLines);
      setIgnoredLines({ aliases: 0 });
    }
  };

  const hasChanges =
    JSON.stringify(whitelist) !== JSON.stringify(savedMap?.whitelist ?? []) ||
    JSON.stringify(aliases) !== JSON.stringify(savedMap?.aliases ?? {}) ||
    maxGenres !== (savedMap?.maxGenres ?? 3);

  const isLoading = mapLoading || previewLoading;
  if (isLoading) return <div className={styles.container}>Loading settings...</div>;

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Settings</h1>
      <SettingsNav />

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Genre Configuration</h2>

        <div className={styles.fieldGroup}>
          <label htmlFor="whitelist" className={styles.label}>
            Whitelist
          </label>
          <p className={styles.hint}>
            Canonical genres to retain when enriching. One per line. Tags from Discogs and MusicBrainz that match
            (case-insensitive) appear in the effective genres list; others become secondary styles.
          </p>
          <textarea
            id="whitelist"
            className={styles.textarea}
            placeholder="Rock&#10;Electronic&#10;Pop&#10;..."
            value={whitelistText}
            onChange={(e) => {
              setWhitelistText(e.target.value);
              setWhitelist(e.target.value.split('\n').map((line) => line.trim()).filter(Boolean));
            }}
            rows={8}
          />
        </div>

        <div className={styles.fieldGroup}>
          <label htmlFor="aliases" className={styles.label}>
            Aliases
          </label>
          <p className={styles.hint}>
            Map non-whitelisted tags to canonical genres. Format: one alias per line, 'from = to'. Blank and
            invalid lines are silently skipped.
            {ignoredLines.aliases > 0 && (
              <span className={styles.ignoredCount}> ({ignoredLines.aliases} ignored)</span>
            )}
          </p>
          <textarea
            id="aliases"
            className={styles.textarea}
            placeholder="metal = Metal&#10;electronic = Electronic&#10;..."
            value={aliasesText}
            onChange={(e) => handleAliasesChange(e.target.value)}
            rows={8}
          />
        </div>

        <div className={styles.fieldGroup}>
          <label htmlFor="maxGenres" className={styles.label}>
            Maximum genres per album
          </label>
          <p className={styles.hint}>The maximum number of effective genres to select (1–10). Defaults to 3.</p>
          <input
            id="maxGenres"
            type="number"
            min="1"
            max="10"
            className={styles.input}
            value={maxGenres}
            onChange={(e) => setMaxGenres(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))}
          />
        </div>

        <div className={styles.actions}>
          <button
            onClick={handleSave}
            disabled={!hasChanges || patchGenreMap.isPending}
            className={styles.button}
          >
            {patchGenreMap.isPending ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleReset}
            disabled={!hasChanges}
            className={styles.resetButton}
          >
            Reset to defaults
          </button>
          {patchGenreMap.isSuccess && <span className={styles.success}>Settings saved</span>}
          {patchGenreMap.isError && (
            <span className={styles.error}>
              {(patchGenreMap.error as { detail?: string; message?: string })?.detail ??
                (patchGenreMap.error as Error)?.message ?? 'Failed to save'}
            </span>
          )}
        </div>
      </div>

      {previewData && (
        <>
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Effective Genres</h2>
            <p className={styles.hint}>Distribution of effective genres across your library's release groups.</p>
            <div className={styles.histogramContainer}>
              {previewData.histogram.length === 0 ? (
                <p className={styles.emptyMessage}>No genres found.</p>
              ) : (
                previewData.histogram.map((item) => {
                  const maxCount = Math.max(...previewData.histogram.map((h) => h.albums));
                  const width = maxCount > 0 ? (item.albums / maxCount) * 100 : 0;
                  return (
                    <div key={item.genre} className={styles.histogramRow}>
                      <div className={styles.genreLabel}>{item.genre}</div>
                      <div className={styles.barContainer}>
                        <div className={styles.bar} style={{ width: `${width}%` }} />
                      </div>
                      <div className={styles.count}>{item.albums}</div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Raw Tags</h2>
            <p className={styles.hint}>
              All raw tags from Discogs and MusicBrainz (top 200), with their mapping status. Hover over the source
              for details.
            </p>
            <div className={styles.tableContainer}>
              {previewData.tags.length === 0 ? (
                <p className={styles.emptyMessage}>No tags found.</p>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>Kind</th>
                      <th>Source</th>
                      <th>Count</th>
                      <th>Maps to</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.tags.map((tag, idx) => (
                      <tr key={`${tag.tag}-${tag.source}-${idx}`}>
                        <td>{tag.tag}</td>
                        <td>{tag.kind}</td>
                        <td title={`${tag.source}${tag.weight !== null ? ` (weight: ${tag.weight})` : ''}`}>
                          {tag.source}
                        </td>
                        <td>{tag.count ?? '—'}</td>
                        <td>{tag.mappedTo || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
