/**
 * Tag plan wizard — 4-step form for creating and applying tag plans (XO-358)
 * Step 1: Scope picker (library/artist/albums/query)
 * Step 2: Policy preset picker + per-field overrides
 * Step 3: Preview table (file path, field names, before/after, locked-field markers)
 * Step 4: Apply with progress bar, pause/resume/cancel, revert button
 */

import { useState, useCallback, useEffect } from 'react';
import type { TagPlanScope, TagPolicies, CreateTagPlan } from '@liner/shared';
import { useNavigate } from '@tanstack/react-router';
import { useCreateTagPlan, useLibrarySettings } from '../hooks/usePlanWizard';
import { useCurrentLibrary } from '../hooks';
import { useArtistsList } from '../hooks/useArtists';
import { useAlbums, useScanRoots } from '../hooks/useLibrary';
import styles from './PlanWizard.module.css';

interface WizardStep1State {
  scopeType: 'library' | 'artist' | 'albumIds' | 'filterQuery' | null;
  artistId?: string;
  /** display only — the API takes the id */
  artistName?: string;
  albumIds?: string[];
  /** display only — id → "Artist — Title" */
  albumLabels?: Record<string, string>;
  filterQuery?: Record<string, unknown>;
  /** what the user typed for the filter scope, kept verbatim while editing */
  filterText?: string;
}

/** `genre=Jazz&decade=1970&genre=Rock` → { genre: ['Jazz', 'Rock'], decade: '1970' } */
function parseFilterText(text: string): Record<string, unknown> {
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

interface WizardStep2State {
  preset: 'canonical_ids_and_fill' | 'fill_blanks_only' | 'overwrite_all' | 'custom';
  id3Version: '2.3' | '2.4';
  multiValueSeparator: string;
  overrides?: Record<string, 'overwrite' | 'fill' | 'never'>;
}

type WizardStep = 1 | 2;

interface PlanWizardProps {
  libraryId: string;
  onClose: () => void;
}

export function PlanWizard({ libraryId, onClose }: PlanWizardProps) {
  const [step, setStep] = useState<WizardStep>(1);
  const [planName, setPlanName] = useState('New tag plan');
  const [step1, setStep1] = useState<WizardStep1State>({ scopeType: null });
  const [step2, setStep2] = useState<WizardStep2State>({
    preset: 'canonical_ids_and_fill',
    id3Version: '2.4',
    multiValueSeparator: '; ',
  });
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const settings = useLibrarySettings(libraryId);
  const scanRoots = useScanRoots(libraryId);
  // New plans start from the library's default policy (Settings › Tag writes);
  // applied once when settings arrive, before the user reaches step 2.
  const [policySeeded, setPolicySeeded] = useState(false);
  useEffect(() => {
    if (policySeeded || !settings.data?.tagPolicy) return;
    const p = settings.data.tagPolicy;
    setStep2({
      preset: p.preset,
      id3Version: p.id3Version,
      multiValueSeparator: p.multiValueSeparator,
      ...(p.overrides ? { overrides: p.overrides } : {}),
    });
    setPolicySeeded(true);
  }, [policySeeded, settings.data]);
  const navigate = useNavigate();
  const createPlanMutation = useCreateTagPlan(libraryId);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // Typing into a search box must not toggle help or jump a step.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '?') {
        setShowHelp((s) => !s);
      }
      if (e.key === 'Enter') {
        // Enter advances; on the last step it creates the plan
        if (step === 1 && step1.scopeType) setStep(2);
        else if (step === 2) void handleCreatePlan();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [step, step1, onClose]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const canProceedStep1 =
    step1.scopeType === 'library' ||
    (step1.scopeType === 'artist' && !!step1.artistId) ||
    (step1.scopeType === 'albumIds' && (step1.albumIds?.length ?? 0) > 0) ||
    (step1.scopeType === 'filterQuery' && Object.keys(step1.filterQuery ?? {}).length > 0);
  const tagWritesDisabled = !settings.data?.tagWritesEnabled;
  // Writable roots come from the scan-roots endpoint; the settings view never
  // carried them, which kept Apply disabled even with everything switched on.
  const noWritableRoots = scanRoots.data !== undefined && !scanRoots.data.some((r) => r.writable);

  const buildScope = (): TagPlanScope | null => {
    switch (step1.scopeType) {
      case 'library':
        return { type: 'library' };
      case 'artist':
        if (!step1.artistId) return null;
        return { type: 'artist', artistId: step1.artistId };
      case 'albumIds':
        if (!step1.albumIds?.length) return null;
        return { type: 'albumIds', albumIds: step1.albumIds };
      case 'filterQuery':
        if (!step1.filterQuery) return null;
        return { type: 'filterQuery', filterQuery: step1.filterQuery };
      default:
        return null;
    }
  };

  const buildPolicy = (): TagPolicies => {
    return {
      preset: step2.preset,
      id3Version: step2.id3Version,
      multiValueSeparator: step2.multiValueSeparator,
      overrides: step2.overrides,
    };
  };

  const handleCreatePlan = async () => {
    const scope = buildScope();
    if (!scope) {
      setStep1Error('Invalid scope configuration');
      return;
    }

    const policy = buildPolicy();
    const payload: CreateTagPlan = {
      name: planName,
      scope,
      policy,
    };

    try {
      const result = await createPlanMutation.mutateAsync(payload);
      // The plan page runs the preview and shows the diff at full width.
      onClose();
      void navigate({ to: '/plans/$planId', params: { planId: result.id } });
    } catch (error) {
      setStep1Error((error as { detail?: string; message?: string })?.detail ?? (error as Error).message ?? 'Failed to create plan');
    }
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="New tag plan">
        <div className={styles.header}>
          <h2 className={styles.title}>New tag plan</h2>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={`${styles.iconBtn} ${showHelp ? styles.iconBtnActive : ''}`}
              onClick={() => setShowHelp(!showHelp)}
              title={showHelp ? 'Back to the wizard (?)' : 'Help (?)'}
              aria-pressed={showHelp}
            >
              ?
            </button>
            <button type="button" className={styles.iconBtn} onClick={onClose} title="Close (Esc)">
              ×
            </button>
          </div>
        </div>

        <div className={styles.body}>
          {(tagWritesDisabled || noWritableRoots) && (
            <div className={styles.warningBanner}>
              <strong>Plans preview, but cannot apply yet.</strong>
              <ul>
                {tagWritesDisabled && (
                  <li>
                    Tag writes are off — <a href="/settings/tag-writes">Settings › Tag writes</a>
                  </li>
                )}
                {noWritableRoots && (
                  <li>
                    No scan root allows writes — <a href="/settings/scan-roots">Settings › Scan roots</a>
                  </li>
                )}
              </ul>
            </div>
          )}

          {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}

        {!showHelp && step === 1 && (
          <Step1ScopePicker
            libraryId={libraryId}
            state={step1}
            onChange={setStep1}
            error={step1Error}
            onNext={() => setStep(2)}
            canProceed={canProceedStep1}
          />
        )}

        {!showHelp && step === 2 && (
          <Step2PolicyPicker
            state={step2}
            onChange={setStep2}
            planName={planName}
            onPlanNameChange={setPlanName}
            onNext={handleCreatePlan}
            onBack={() => setStep(1)}
            isLoading={createPlanMutation.isPending}
          />
        )}


        </div>
      </div>
    </div>
  );
}

/** Search-as-you-type artist picker; only canonical (resolved) artists can scope a plan. */
function ArtistCombo({
  libraryId,
  selected,
  onSelect,
}: {
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
          <button type="button" className={styles.chipRemove} onClick={() => onSelect(null)} title="Change artist">
            ×
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className={styles.combo}>
      <input
        type="search"
        autoFocus
        placeholder="Type an artist name…"
        className={styles.input}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {debounced && (
        <ul className={styles.comboList} role="listbox">
          {results.isLoading && <li className={styles.comboEmpty}>Searching…</li>}
          {!results.isLoading && items.length === 0 && (
            <li className={styles.comboEmpty}>No identified artist matches “{debounced}”. Unidentified albums cannot be scoped by artist yet.</li>
          )}
          {items.map((a) => (
            <li key={a.id!}>
              <button
                type="button"
                className={styles.comboItem}
                onClick={() => {
                  onSelect({ id: a.id!, name: a.name });
                  setQ('');
                }}
              >
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

/** Search-as-you-type album multi-select. */
function AlbumPicker({
  libraryId,
  selectedIds,
  labels,
  onChange,
}: {
  libraryId: string;
  selectedIds: string[];
  labels: Record<string, string>;
  onChange: (ids: string[], labels: Record<string, string>) => void;
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
              <button type="button" className={styles.chipRemove} onClick={() => toggle(id, labels[id] ?? id)} title="Remove">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        type="search"
        autoFocus
        placeholder="Search albums by title or artist…"
        className={styles.input}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {debounced && (
        <ul className={styles.comboList} role="listbox">
          {results.isLoading && <li className={styles.comboEmpty}>Searching…</li>}
          {!results.isLoading && items.length === 0 && <li className={styles.comboEmpty}>No albums match “{debounced}”.</li>}
          {items.map((al) => {
            const label = `${al.artistCredit} — ${al.title}`;
            const checked = selectedIds.includes(al.id);
            return (
              <li key={al.id}>
                <label className={`${styles.comboItem} ${checked ? styles.comboItemChecked : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(al.id, label)} />
                  <span>{label}</span>
                  <span className={styles.comboMeta}>
                    {al.year ?? '—'} · {al.trackCount} tracks · {al.formats.join('/')}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Step1ScopePicker({
  libraryId,
  state,
  onChange,
  error,
  onNext,
  canProceed,
}: {
  libraryId: string;
  state: WizardStep1State;
  onChange: (state: WizardStep1State) => void;
  error: string | null;
  onNext: () => void;
  canProceed: boolean;
}) {
  const pick = (scopeType: WizardStep1State['scopeType']) => onChange({ ...state, scopeType });
  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Step 1: Select scope</p>

      <fieldset className={styles.fieldset}>
        <label className={styles.radioLabel}>
          <input type="radio" name="scope" value="library" checked={state.scopeType === 'library'} onChange={() => pick('library')} />
          Entire library
        </label>

        <div className={styles.scopeBlock}>
          <label className={styles.radioLabel}>
            <input type="radio" name="scope" value="artist" checked={state.scopeType === 'artist'} onChange={() => pick('artist')} />
            All albums by an artist
          </label>
          {state.scopeType === 'artist' && (
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
        </div>

        <div className={styles.scopeBlock}>
          <label className={styles.radioLabel}>
            <input type="radio" name="scope" value="albumIds" checked={state.scopeType === 'albumIds'} onChange={() => pick('albumIds')} />
            Selected albums
          </label>
          {state.scopeType === 'albumIds' && (
            <div className={styles.scopeDetail}>
              <AlbumPicker
                libraryId={libraryId}
                selectedIds={state.albumIds ?? []}
                labels={state.albumLabels ?? {}}
                onChange={(albumIds, albumLabels) => onChange({ ...state, albumIds, albumLabels })}
              />
            </div>
          )}
        </div>

        <div className={styles.scopeBlock}>
          <label className={styles.radioLabel}>
            <input type="radio" name="scope" value="filterQuery" checked={state.scopeType === 'filterQuery'} onChange={() => pick('filterQuery')} />
            Albums matching a filter
          </label>
          {state.scopeType === 'filterQuery' && (
            <div className={styles.scopeDetail}>
              <input
                type="text"
                autoFocus
                placeholder="genre=Jazz&decade=1970&format=lossless"
                className={styles.input}
                value={state.filterText ?? ''}
                onChange={(e) => onChange({ ...state, filterText: e.target.value, filterQuery: parseFilterText(e.target.value) })}
              />
              <p className={styles.hint}>
                Same keys as the album grid URL: state, genre, decade, format, label, gap, owned, review, q. Repeat a key for several values.
              </p>
            </div>
          )}
        </div>
      </fieldset>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.stepActions}>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={onNext} disabled={!canProceed}>
          Next
        </button>
      </div>
    </div>
  );
}

function Step2PolicyPicker({
  state,
  onChange,
  planName,
  onPlanNameChange,
  onNext,
  onBack,
  isLoading,
}: {
  state: WizardStep2State;
  onChange: (state: WizardStep2State) => void;
  planName: string;
  onPlanNameChange: (name: string) => void;
  onNext: () => void;
  onBack: () => void;
  isLoading: boolean;
}) {
  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Step 2: Select policy preset</p>

      <div className={styles.formGroup}>
        <label className={styles.label}>Plan name</label>
        <input
          type="text"
          className={styles.input}
          value={planName}
          onChange={(e) => onPlanNameChange(e.target.value)}
          placeholder="New tag plan"
        />
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Policy preset</legend>

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="preset"
            value="canonical_ids_and_fill"
            checked={state.preset === 'canonical_ids_and_fill'}
            onChange={() => onChange({ ...state, preset: 'canonical_ids_and_fill' })}
          />
          Canonical IDs + fill (default)
          <p className={styles.hint}>
            Overwrite ID tags and key fields; fill blanks for title, artist, genre, compilation
          </p>
        </label>

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="preset"
            value="fill_blanks_only"
            checked={state.preset === 'fill_blanks_only'}
            onChange={() => onChange({ ...state, preset: 'fill_blanks_only' })}
          />
          Fill blanks only
          <p className={styles.hint}>Never overwrite; only set empty fields</p>
        </label>

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="preset"
            value="overwrite_all"
            checked={state.preset === 'overwrite_all'}
            onChange={() => onChange({ ...state, preset: 'overwrite_all' })}
          />
          Overwrite all
          <p className={styles.hint}>Replace all canonical fields with new values</p>
        </label>

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="preset"
            value="custom"
            checked={state.preset === 'custom'}
            onChange={() => onChange({ ...state, preset: 'custom' })}
          />
          Custom (per-field rules)
          <p className={styles.hint}>Advanced: configure each field individually</p>
        </label>
      </fieldset>

      <div className={styles.formGroup}>
        <label className={styles.label}>ID3 version (for MP3 files)</label>
        <select
          className={styles.select}
          value={state.id3Version}
          onChange={(e) => onChange({ ...state, id3Version: e.target.value as '2.3' | '2.4' })}
        >
          <option value="2.4">ID3 v2.4 UTF-8 (default, recommended)</option>
          <option value="2.3">ID3 v2.3 (legacy players)</option>
        </select>
      </div>

      <div className={styles.stepActions}>
        <button className={styles.btn} onClick={onBack}>
          Back
        </button>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={onNext}
          disabled={isLoading}
        >
          {isLoading ? 'Creating…' : 'Create plan & preview'}
        </button>
      </div>
    </div>
  );
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className={styles.helpOverlay}>
      <div className={styles.helpHead}>
        <h3>Tag plan wizard help</h3>
        <button type="button" className={styles.btn} onClick={onClose}>
          Back to the wizard
        </button>
      </div>
      <section>
        <h4>Scope types</h4>
        <dl>
          <dt>Entire library</dt>
          <dd>Apply to all audio files in the library</dd>
          <dt>All albums by an artist</dt>
          <dd>Apply only to albums by a specific artist (including albums by featured artists)</dd>
          <dt>Selected albums</dt>
          <dd>Pick one or more albums to target (multi-select)</dd>
          <dt>Filter query</dt>
          <dd>Use the same filter syntax as the album grid (e.g. genre=Jazz)</dd>
        </dl>
      </section>
      <section>
        <h4>Policy presets</h4>
        <dl>
          <dt>Canonical IDs + fill</dt>
          <dd>
            Overwrite: musicbrainz_*, discogs_*, album, artist, date, tracknumber, etc.
            Fill (blanks only): title, genre, compilation. Never touch: comments, ratings, unknown tags.
          </dd>
          <dt>Fill blanks only</dt>
          <dd>Never overwrite existing values; only set empty fields</dd>
          <dt>Overwrite all</dt>
          <dd>Replace all canonical fields with values from the matched release</dd>
          <dt>Custom</dt>
          <dd>Configure each field individually (overwrite, fill, or never touch)</dd>
        </dl>
      </section>
      <section>
        <h4>Keyboard shortcuts</h4>
        <dl>
          <dt>Escape</dt>
          <dd>Close wizard</dd>
          <dt>Tab</dt>
          <dd>Move to next field</dd>
          <dt>Enter</dt>
          <dd>Submit current step</dd>
          <dt>?</dt>
          <dd>Toggle this help</dd>
        </dl>
      </section>
    </div>
  );
}
