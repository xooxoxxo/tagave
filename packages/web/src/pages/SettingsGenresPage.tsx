/**
 * Library care › Genre mapping (spec XO-310 §7): the genre whitelist, the
 * aliases and the most genres an album keeps, typed and saved with the
 * group's one Save (Reset beside it drops the edits, the aliases being a
 * long text); then what the map makes of the library: Effective genres and
 * Raw tags. GenreMappingView is the tab alone, driven by props (stories,
 * tests); SettingsGenresContent connects it.
 */
import { useState, type ReactNode } from 'react';
import { useCurrentLibrary } from '../hooks';
import { useGenreMap, usePatchGenreMap, useGenrePreview, type GenreMap, type GenrePreviewResponse } from '../hooks/useArtists';
import { Button, Input, SettingsGroup, SettingsRow, SettingsSave, Textarea, useSaveFlash, type SaveState } from '../components/ui';
import styles from './SettingsGenresPage.module.css';

/** "metal = Metal" lines → { metal: 'Metal' }, and how many lines it could not read. */
export function parseAliases(text: string): { parsed: Record<string, string>; ignored: number } {
  const parsed: Record<string, string> = {};
  let ignored = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(.+?)\s*=\s*(.+)$/);
    const from = match?.[1]?.trim().toLowerCase();
    const to = match?.[2]?.trim();
    if (!from || !to) { ignored += 1; continue; }
    parsed[from] = to;
  }
  return { parsed, ignored };
}

const parseWhitelist = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
const aliasText = (aliases: Record<string, string>) => Object.entries(aliases).map(([from, to]) => `${from} = ${to}`).join('\n');

export interface GenreMappingViewProps {
  whitelistText: string;
  aliasesText: string;
  maxGenres: number;
  /** alias lines that are not "from = to" */
  ignored: number;
  dirty: boolean;
  pending?: boolean;
  state?: SaveState;
  detail?: string | null;
  /** what the map makes of the library; null while it loads */
  preview: GenrePreviewResponse | null;
  onWhitelist: (text: string) => void;
  onAliases: (text: string) => void;
  onMaxGenres: (n: number) => void;
  onSave: () => void;
  onReset: () => void;
}

export function GenreMappingView({ whitelistText, aliasesText, maxGenres, ignored, dirty, pending = false, state = null, detail = null, preview, onWhitelist, onAliases, onMaxGenres, onSave, onReset }: GenreMappingViewProps) {
  const most = preview ? Math.max(0, ...preview.histogram.map((h) => h.albums)) : 0;
  let effective: ReactNode = null;
  if (preview && preview.histogram.length > 0) {
    effective = (
      <div className={styles.histogram}>
        {preview.histogram.map((item) => (
          <div key={item.genre} className={styles.histogramRow}>
            <div className={styles.genreLabel}>{item.genre}</div>
            <div className={styles.barContainer}>
              <div className={styles.bar} style={{ ['--scale' as string]: `${most > 0 ? item.albums / most : 0}` }} />
            </div>
            <div className={styles.count}>{item.albums}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={styles.page}>
      <form onSubmit={(e) => { e.preventDefault(); if (dirty && !pending) onSave(); }} noValidate>
        <SettingsGroup
          title="Genre mapping"
          after={(
            <div className={styles.buttons}>
              <SettingsSave type="submit" dirty={dirty} pending={pending} onSave={() => undefined} state={state} detail={detail} />
              <Button variant="quiet" size="sm" onClick={onReset} disabled={!dirty || pending}>Reset</Button>
            </div>
          )}
        >
          <SettingsRow label="Whitelist" help="One genre a line; an album keeps only these">
            <Textarea className={styles.textarea} placeholder={'Rock\nElectronic\nPop'} value={whitelistText} onChange={(e) => onWhitelist(e.currentTarget.value)} rows={6} spellCheck={false} />
          </SettingsRow>
          <SettingsRow label="Aliases" help="One a line, as tag = Genre">
            <span className={styles.stack}>
              <Textarea className={styles.textarea} placeholder={'metal = Metal\nelectronic = Electronic'} value={aliasesText} onChange={(e) => onAliases(e.currentTarget.value)} rows={6} spellCheck={false} />
              {ignored > 0 && <span className={styles.value}>{ignored === 1 ? '1 line ignored' : `${ignored} lines ignored`}</span>}
            </span>
          </SettingsRow>
          <SettingsRow label="Max genres">
            <Input dense type="number" min={1} max={10} className={styles.number} value={maxGenres} onChange={(e) => onMaxGenres(Math.max(1, Math.min(10, parseInt(e.currentTarget.value, 10) || 1)))} />
          </SettingsRow>
        </SettingsGroup>
      </form>

      {preview && (
        <>
          <SettingsGroup title="Effective genres" meta={preview.histogram.length === 0 ? 'No genres' : null} after={effective} />
          <SettingsGroup
            title="Raw tags"
            meta={preview.tags.length === 0 ? 'No tags' : null}
            after={preview.tags.length > 0 ? (
              <div className={styles.tableContainer} role="region" aria-label="Raw tags" tabIndex={0}>
                <table className={styles.table}>
                  <thead>
                    <tr><th>Tag</th><th>Kind</th><th>Source</th><th>Count</th><th>Maps to</th></tr>
                  </thead>
                  <tbody>
                    {preview.tags.map((tag, idx) => (
                      <tr key={`${tag.tag}-${tag.source}-${idx}`}>
                        <td>{tag.tag}</td>
                        <td>{tag.kind}</td>
                        <td title={`${tag.source}${tag.weight !== null ? ` (weight: ${tag.weight})` : ''}`}>{tag.source}</td>
                        <td>{tag.count ?? 0}</td>
                        <td>{tag.mappedTo || 'Not mapped'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          />
        </>
      )}
    </div>
  );
}

interface GenreTexts {
  whitelistText: string;
  aliasesText: string;
  maxGenres: number;
}

const textsOf = (map: GenreMap): GenreTexts => ({ whitelistText: map.whitelist.join('\n'), aliasesText: aliasText(map.aliases), maxGenres: map.maxGenres });

/** Library care › Genre mapping, connected; nothing until the map loads. */
export function SettingsGenresContent() {
  const { libraryId } = useCurrentLibrary();
  const { data: stored } = useGenreMap(libraryId);
  const { data: preview } = useGenrePreview(libraryId);
  const patch = usePatchGenreMap(libraryId);
  const flash = useSaveFlash();
  const [edit, setEdit] = useState<GenreTexts | null>(null);
  if (!stored) return null;
  const texts = edit ?? textsOf(stored);
  const aliases = parseAliases(texts.aliasesText);
  const next: GenreMap = { whitelist: parseWhitelist(texts.whitelistText), aliases: aliases.parsed, maxGenres: texts.maxGenres };
  const dirty = JSON.stringify(next.whitelist) !== JSON.stringify(stored.whitelist)
    || JSON.stringify(next.aliases) !== JSON.stringify(stored.aliases)
    || next.maxGenres !== stored.maxGenres;
  const change = (patchTexts: Partial<GenreTexts>) => setEdit({ ...texts, ...patchTexts });

  return (
    <GenreMappingView
      {...texts}
      ignored={aliases.ignored}
      dirty={dirty}
      pending={patch.isPending}
      state={flash.state}
      detail={flash.detail}
      preview={preview ?? null}
      onWhitelist={(whitelistText) => change({ whitelistText })}
      onAliases={(aliasesText) => change({ aliasesText })}
      onMaxGenres={(maxGenres) => change({ maxGenres })}
      onReset={() => { setEdit(null); flash.clear(); }}
      onSave={() => {
        flash.clear();
        patch.mutate(next, {
          onSuccess: () => { setEdit(null); flash.saved(); },
          onError: (err) => flash.failed((err as { detail?: string } | null)?.detail ?? null),
        });
      }}
    />
  );
}
