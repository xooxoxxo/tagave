/**
 * The controls inside the Tag sheet's rows (TagSheet.tsx), from the old tag
 * plan wizard (XO-358): what a plan covers (library, an artist, albums, a
 * filter), the policy preset and the ID3 version, and the plans not applied
 * yet that albums can be added to. Labels and values only.
 */
import { useEffect, useState } from 'react';
import type { TagPlan } from '@tagave/shared';
import { useArtistsList } from '../hooks/useArtists';
import { useAlbums } from '../hooks/useLibrary';
import styles from './tagPlanControls.module.css';

export type ScopeType = 'library' | 'artist' | 'albumIds' | 'filterQuery';

export interface ScopeState {
  scopeType: ScopeType | null;
  artistId?: string;
  /** display only: the API takes the id */
  artistName?: string;
  albumIds?: string[];
  /** display only: id → "Artist — Title" */
  albumLabels?: Record<string, string>;
  filterQuery?: Record<string, unknown>;
  /** what the user typed for the filter scope, kept verbatim while editing */
  filterText?: string;
}

export type Preset = 'canonical_ids_and_fill' | 'fill_blanks_only' | 'overwrite_all' | 'custom';

export interface PolicyState {
  preset: Preset;
  id3Version: '2.3' | '2.4';
  multiValueSeparator: string;
  overrides?: Record<string, 'overwrite' | 'fill' | 'never'>;
}

export const PRESETS: Array<{ id: Preset; label: string; title: string }> = [
  { id: 'canonical_ids_and_fill', label: 'Canonical IDs + fill', title: 'Overwrite ID tags and key fields; fill blanks for title, artist, genre, compilation' },
  { id: 'fill_blanks_only', label: 'Fill blanks only', title: 'Never overwrite; only set empty fields' },
  { id: 'overwrite_all', label: 'Overwrite all', title: 'Replace all canonical fields with new values' },
  { id: 'custom', label: 'Custom', title: 'Per-field rules from Settings › Tag preferences' },
];

/**
 * The preset a new plan starts from: the library's default policy (Settings ›
 * Tag preferences); a manual or revert default is not a preset to pick.
 */
export function defaultPresetOf(policy: { preset: string } | null | undefined): Preset {
  const p = policy?.preset;
  return p === 'fill_blanks_only' || p === 'overwrite_all' || p === 'custom' || p === 'canonical_ids_and_fill' ? p : 'canonical_ids_and_fill';
}

/** "1997 · 11 tracks · flac/mp3" under an album in the picker. */
export function albumPickMeta(al: { year?: number | null | undefined; trackCount: number; formats: string[] }): string {
  return [al.year ? String(al.year) : null, `${al.trackCount.toLocaleString()} ${al.trackCount === 1 ? 'track' : 'tracks'}`, al.formats.join('/') || null]
    .filter(Boolean).join(' · ');
}

/** True when the plan is a list of albums that already has every one of these. */
export function planIncludesAll(plan: TagPlan, albumIds: string[]): boolean {
  if (albumIds.length === 0 || plan.scope.type !== 'albumIds') return false;
  const inPlan = new Set(plan.scope.albumIds);
  return albumIds.every((id) => inPlan.has(id));
}

/** `genre=Jazz&decade=1970&genre=Rock` → { genre: ['Jazz', 'Rock'], decade: '1970' } */
export function parseFilterText(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const params = new URLSearchParams(text.trim().replace(/^\?/, ''));
  for (const [key, value] of params) {
    if (!key) continue;
    const prev = out[key];
    if (prev === undefined) out[key] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else out[key] = [prev, value];
  }
  return out;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Search-as-you-type artist picker; only canonical (resolved) artists can scope a plan. */
function ArtistCombo({ libraryId, selected, onSelect }: {
  libraryId: string;
  selected: { id: string; name: string } | null;
  onSelect: (artist: { id: string; name: string } | null) => void;
}) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 250);
  const results = useArtistsList(libraryId, debounced ? { search: debounced, limit: 15 } : { limit: 0 });
  const items = debounced ? (results.data?.items ?? []).filter((a) => a.id !== null) : [];
  if (selected) {
    return (
      <div className={styles.chips}>
        <span className={styles.chip}>
          {selected.name}
          <button type="button" className={styles.chipRemove} onClick={() => onSelect(null)} title="Change artist">×</button>
        </span>
      </div>
    );
  }
  return (
    <div className={styles.combo}>
      <input type="search" aria-label="Artist" placeholder="Artist" className={styles.input} value={q} onChange={(e) => setQ(e.target.value)} />
      {debounced && (
        <ul className={styles.comboList} role="listbox">
          {results.isLoading && <li className={styles.comboEmpty}>Searching…</li>}
          {!results.isLoading && items.length === 0 && <li className={styles.comboEmpty}>No identified artist</li>}
          {items.map((a) => (
            <li key={a.id!}>
              <button type="button" className={styles.comboItem} onClick={() => { onSelect({ id: a.id!, name: a.name }); setQ(''); }}>
                <span>{a.name}</span>
                <span className={styles.comboMeta}>
                  {a.albumCount} album{a.albumCount === 1 ? '' : 's'}
                  {a.yearFrom ? ` · ${a.yearFrom}${a.yearTo && a.yearTo !== a.yearFrom ? `–${a.yearTo}` : ''}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Search-as-you-type album multi-select: a result row toggles its album (aria-pressed), chips remove one. */
export function AlbumPicker({ libraryId, selectedIds, labels, onChange, alreadyIn = [] }: {
  libraryId: string;
  selectedIds: string[];
  labels: Record<string, string>;
  onChange: (ids: string[], labels: Record<string, string>) => void;
  /** albums the target plan already covers: shown, not pickable */
  alreadyIn?: string[];
}) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 250);
  const results = useAlbums(libraryId, debounced ? { search: debounced, limit: 15, sort: 'artist' } : { limit: 0 });
  const items = debounced ? results.data?.items ?? [] : [];
  const toggle = (id: string, label: string) => {
    if (selectedIds.includes(id)) {
      const rest = { ...labels };
      delete rest[id];
      onChange(selectedIds.filter((x) => x !== id), rest);
    } else {
      onChange([...selectedIds, id], { ...labels, [id]: label });
    }
  };
  return (
    <div className={styles.combo}>
      {selectedIds.length > 0 && (
        <div className={styles.chips}>
          {selectedIds.map((id) => (
            <span key={id} className={styles.chip}>
              {labels[id] ?? id}
              <button type="button" className={styles.chipRemove} onClick={() => toggle(id, labels[id] ?? id)} title="Remove">×</button>
            </span>
          ))}
        </div>
      )}
      <input type="search" aria-label="Albums" placeholder="Title or artist" className={styles.input} value={q} onChange={(e) => setQ(e.target.value)} />
      {debounced && (
        <ul className={styles.comboList} role="listbox" aria-multiselectable="true">
          {results.isLoading && <li className={styles.comboEmpty}>Searching…</li>}
          {!results.isLoading && items.length === 0 && <li className={styles.comboEmpty}>No albums</li>}
          {items.map((al) => {
            const label = `${al.artistCredit} — ${al.title}`;
            const inPlan = alreadyIn.includes(al.id);
            const picked = inPlan || selectedIds.includes(al.id);
            return (
              <li key={al.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={picked}
                  disabled={inPlan}
                  className={`${styles.comboItem} ${picked ? styles.comboItemChecked : ''} ${inPlan ? styles.comboItemDisabled : ''}`}
                  onClick={() => toggle(al.id, label)}
                >
                  <span>{label}</span>
                  <span className={styles.comboMeta}>{inPlan ? 'In this plan' : albumPickMeta(al)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const SCOPES: Array<{ id: ScopeType; label: string }> = [
  { id: 'albumIds', label: 'Albums' },
  { id: 'artist', label: 'An artist' },
  { id: 'filterQuery', label: 'A filter' },
  { id: 'library', label: 'Entire library' },
];

/** What the plan covers: one of four, with its picker under the chosen one. */
export function ScopePicker({ libraryId, state, onChange }: { libraryId: string; state: ScopeState; onChange: (s: ScopeState) => void }) {
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.legend}>Covers</legend>
      {SCOPES.map((sc) => (
        <div key={sc.id} className={styles.scopeBlock}>
          <label className={styles.radioLabel}>
            <input type="radio" name="tag-scope" value={sc.id} checked={state.scopeType === sc.id} onChange={() => onChange({ ...state, scopeType: sc.id })} />
            <span className={styles.choiceText}><span>{sc.label}</span></span>
          </label>
          {state.scopeType === sc.id && sc.id === 'artist' && (
            <div className={styles.scopeDetail}>
              <ArtistCombo
                libraryId={libraryId}
                selected={state.artistId && state.artistName ? { id: state.artistId, name: state.artistName } : null}
                onSelect={(a) => {
                  const { artistId: _id, artistName: _name, ...rest } = state;
                  onChange(a ? { ...rest, artistId: a.id, artistName: a.name } : rest);
                }}
              />
            </div>
          )}
          {state.scopeType === sc.id && sc.id === 'albumIds' && (
            <div className={styles.scopeDetail}>
              <AlbumPicker
                libraryId={libraryId}
                selectedIds={state.albumIds ?? []}
                labels={state.albumLabels ?? {}}
                onChange={(albumIds, albumLabels) => onChange({ ...state, albumIds, albumLabels })}
              />
            </div>
          )}
          {state.scopeType === sc.id && sc.id === 'filterQuery' && (
            <div className={styles.scopeDetail}>
              <input
                type="text"
                aria-label="Filter"
                placeholder="genre=Jazz&decade=1970"
                className={styles.input}
                value={state.filterText ?? ''}
                onChange={(e) => onChange({ ...state, filterText: e.target.value, filterQuery: parseFilterText(e.target.value) })}
              />
            </div>
          )}
        </div>
      ))}
    </fieldset>
  );
}

/** The policy preset (the library's default marked) and the ID3 version for MP3s. */
export function PolicyPicker({ state, onChange, defaultPreset }: { state: PolicyState; onChange: (s: PolicyState) => void; defaultPreset: Preset }) {
  return (
    <>
      <fieldset className={`${styles.fieldset} ${styles.presetGrid}`}>
        <legend className={styles.legend}>Preset</legend>
        {PRESETS.map((p) => (
          <label key={p.id} className={styles.presetCard} title={p.title}>
            <input type="radio" name="tag-preset" value={p.id} checked={state.preset === p.id} onChange={() => onChange({ ...state, preset: p.id })} />
            <span className={styles.choiceText}>
              <span className={styles.choiceLabel}>{p.label}{p.id === defaultPreset ? ' (default)' : ''}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className={styles.formGroup}>
        <label className={styles.label} htmlFor="tag-sheet-id3">ID3 (MP3)</label>
        <select id="tag-sheet-id3" className={styles.select} value={state.id3Version} onChange={(e) => onChange({ ...state, id3Version: e.target.value as '2.3' | '2.4' })}>
          <option value="2.4">v2.4 UTF-8</option>
          <option value="2.3">v2.3</option>
        </select>
      </div>
    </>
  );
}

const PLAN_STATUS_LABEL: Record<string, string> = { draft: 'Not previewed', previewed: 'Previewed' };

/** A new plan, or one not applied yet to add the albums to (one that already has them cannot be picked). */
export function PlanPicker({ openPlans, total, albumIds, value, onChange }: {
  openPlans: TagPlan[];
  total: number;
  albumIds: string[];
  /** 'new' or a plan id */
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.legend}>Plan</legend>
      <label className={styles.radioLabel}>
        <input type="radio" name="tag-plan" value="new" checked={value === 'new'} onChange={() => onChange('new')} />
        <span className={styles.choiceText}><span>New plan</span></span>
      </label>
      {openPlans.map((plan) => {
        const already = planIncludesAll(plan, albumIds);
        return (
          <label key={plan.id} className={`${styles.radioLabel} ${already ? styles.radioLabelDisabled : ''}`}>
            <input type="radio" name="tag-plan" value={plan.id} checked={value === plan.id} disabled={already} onChange={() => onChange(plan.id)} />
            <span className={styles.choiceText}>
              <span>{plan.name || 'Untitled plan'}</span>
              <span className={styles.choiceMeta}>
                {already ? 'Has this album' : [plan.scopeLabel, PLAN_STATUS_LABEL[plan.status]].filter(Boolean).join(' · ')}
              </span>
            </span>
          </label>
        );
      })}
      {total > openPlans.length && <p className={styles.choiceMeta}>{openPlans.length} of {total.toLocaleString()}</p>}
    </fieldset>
  );
}
