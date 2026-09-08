/**
 * Tag plan wizard — 4-step form for creating and applying tag plans (XO-358)
 * Step 1: Scope picker (library/artist/albums/query)
 * Step 2: Policy preset picker + per-field overrides
 * Step 3: Preview table (file path, field names, before/after, locked-field markers)
 * Step 4: Apply with progress bar, pause/resume/cancel, revert button
 */

import { useState, useCallback, useEffect } from 'react';
import type { TagPlanScope, TagPolicies, CreateTagPlan } from '@liner/shared';
import {
  useCreateTagPlan,
  usePreviewTagPlan,
  useApplyTagPlan,
  useLibrarySettings,
  useTagPlan,
  usePauseTagPlan,
  useResumeTagPlan,
  useCancelTagPlan,
  useRevertTagPlan,
} from '../hooks/usePlanWizard';
import { useCurrentLibrary } from '../hooks';
import { useJobs } from '../hooks/useIdentify';
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

type WizardStep = 1 | 2 | 3 | 4;

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
  const [createdPlanId, setCreatedPlanId] = useState<string | null>(null);
  const [appliedJobId, setAppliedJobId] = useState<string | null>(null);
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
  const tagPlan = useTagPlan(libraryId, createdPlanId || undefined);
  const createPlanMutation = useCreateTagPlan(libraryId);
  const previewMutation = usePreviewTagPlan(libraryId, createdPlanId || undefined);
  const applyMutation = useApplyTagPlan(libraryId, createdPlanId || undefined);
  const pauseMutation = usePauseTagPlan(libraryId, createdPlanId || undefined);
  const resumeMutation = useResumeTagPlan(libraryId, createdPlanId || undefined);
  const cancelMutation = useCancelTagPlan(libraryId, createdPlanId || undefined);
  const revertMutation = useRevertTagPlan(libraryId, createdPlanId || undefined);
  const jobsData = useJobs(libraryId);
  const currentJob = appliedJobId ? jobsData.data?.data?.find((j) => j.id === appliedJobId) : null;

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
      if (e.key === 'Enter' && step < 4) {
        // Auto-advance on Enter if validation passes
        if (step === 1 && step1.scopeType) setStep(2);
        else if (step === 2) setStep(3);
      }
    },
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
      setCreatedPlanId(result.id);
      setStep(3);
    } catch (error) {
      setStep1Error((error as Error).message || 'Failed to create plan');
    }
  };

  const handlePreviewPlan = async () => {
    if (!createdPlanId) return;
    try {
      await previewMutation.mutateAsync();
      // Stay on step 3 to show preview
    } catch (error) {
      setStep1Error((error as Error).message || 'Failed to preview plan');
    }
  };

  const handleApplyPlan = async () => {
    if (!createdPlanId) return;
    try {
      const result = await applyMutation.mutateAsync();
      setAppliedJobId(result.jobId);
      setStep(4);
    } catch (error) {
      setStep1Error((error as Error).message || 'Failed to apply plan');
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

        {!showHelp && step === 3 && createdPlanId && (
          <Step3PreviewTable
            libraryId={libraryId}
            planId={createdPlanId}
            onPreview={handlePreviewPlan}
            previewPending={previewMutation.isPending}
            onApply={handleApplyPlan}
            onBack={() => {
              setCreatedPlanId(null);
              setStep(2);
            }}
            isLoading={applyMutation.isPending}
            error={step1Error}
            tagWritesDisabled={tagWritesDisabled}
            noWritableRoots={noWritableRoots}
          />
        )}

        {!showHelp && step === 4 && appliedJobId && currentJob && (
          <Step4Progress
            job={currentJob}
            planId={createdPlanId || ''}
            libraryId={libraryId}
            onClose={onClose}
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
          {isLoading ? 'Creating...' : 'Next'}
        </button>
      </div>
    </div>
  );
}

const PAGE_SIZE = 100;

function fmtValue(v: string | string[] | null): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.join('; ');
  return v === '' ? '(empty)' : v;
}

/**
 * Step 3: the plan is previewed (a worker job computes per-file diffs without
 * touching disk), then the aggregate and the diff table are shown; Apply is
 * enabled only once the preview exists and the write gates are open.
 */
function Step3PreviewTable({
  libraryId,
  planId,
  onPreview,
  previewPending,
  onApply,
  onBack,
  isLoading,
  error,
  tagWritesDisabled,
  noWritableRoots,
}: {
  libraryId: string;
  planId: string;
  onPreview: () => void;
  previewPending: boolean;
  onApply: () => void;
  onBack: () => void;
  isLoading: boolean;
  error: string | null;
  tagWritesDisabled: boolean;
  noWritableRoots: boolean;
}) {
  const [requested, setRequested] = useState(false);
  const [field, setField] = useState('');
  const [offset, setOffset] = useState(0);

  // Poll the plan while the preview job runs.
  const plan = useTagPlan(libraryId, planId, { refetchInterval: requested ? 2000 : false });
  const status = plan.data?.status;
  const previewed = status !== undefined && status !== 'draft';

  // Kick off the preview once when arriving on a draft.
  useEffect(() => {
    if (!requested && status === 'draft') {
      setRequested(true);
      onPreview();
    }
    if (previewed && requested && plan.data?.stats) setRequested(false);
  }, [requested, status, previewed, onPreview, plan.data?.stats]);

  const items = useTagPlanItems(libraryId, planId, {
    ...(field ? { fieldFilter: field } : {}),
    limit: PAGE_SIZE,
    offset,
    enabled: previewed,
  });

  const stats = plan.data?.stats;
  const nothingToDo = previewed && stats !== undefined && stats.filesTouched === 0;
  const canApply = previewed && !nothingToDo && !tagWritesDisabled && !noWritableRoots;
  const applyTitle = !previewed
    ? 'Preview has not finished yet'
    : nothingToDo
      ? 'Nothing to change'
      : tagWritesDisabled
        ? 'Tag writes disabled in library settings'
        : noWritableRoots
          ? 'No writable scan roots configured'
          : undefined;

  const fields = new Set<string>();
  for (const it of items.data?.items ?? []) for (const d of it.diffs) fields.add(d.field);
  const total = items.data?.total ?? 0;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Step 3: Preview changes</p>
      <p className={styles.stepSubtitle}>
        Nothing is written yet. Each row is one file; each line the field it would change.
      </p>

      {!previewed && (
        <div className={styles.previewInfo}>
          <p>{previewPending || requested ? 'Computing the preview…' : 'Waiting for the preview…'}</p>
          <p className={styles.hint}>Every file in scope is read once; a whole-library plan can take a few minutes.</p>
        </div>
      )}

      {previewed && stats && (
        <div className={styles.summaryGrid}>
          <div className={styles.summaryCell}><strong>{stats.filesTouched.toLocaleString()}</strong><span>files change</span></div>
          <div className={styles.summaryCell}><strong>{stats.fieldsModified.toLocaleString()}</strong><span>field changes</span></div>
          <div className={styles.summaryCell}><strong>{stats.lockedFieldsRespected.toLocaleString()}</strong><span>locked fields kept</span></div>
          <div className={styles.summaryCell}><strong>{stats.filesSkipped.length.toLocaleString()}</strong><span>files skipped</span></div>
        </div>
      )}

      {previewed && stats && stats.filesSkipped.length > 0 && (
        <p className={styles.hint}>
          Skipped: {Object.entries(stats.filesSkipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {}))
            .map(([reason, n]) => `${n} × ${reason.replaceAll('_', ' ')}`).join(', ')}
        </p>
      )}

      {previewed && !nothingToDo && (
        <>
          <div className={styles.tableTools}>
            <label className={styles.label} htmlFor="fieldFilter">Field</label>
            <select id="fieldFilter" className={styles.select} value={field} onChange={(e) => { setField(e.target.value); setOffset(0); }}>
              <option value="">all fields</option>
              {[...fields].sort().map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <span className={styles.tableCount}>
              {items.isLoading ? 'Loading…' : total === 0 ? 'No rows' : `${offset + 1}–${pageEnd} of ${total.toLocaleString()} files`}
            </span>
            <span className={styles.pager}>
              <button type="button" className={styles.btn} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>‹</button>
              <button type="button" className={styles.btn} disabled={pageEnd >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>›</button>
            </span>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.diffTable}>
              <thead>
                <tr><th>File</th><th>Field</th><th>Before</th><th>After</th><th>Why</th></tr>
              </thead>
              <tbody>
                {(items.data?.items ?? []).map((it) => {
                  const rows = it.diffs.filter((d) => d.reason !== 'no-change');
                  if (rows.length === 0) return null;
                  return rows.map((d, i) => (
                    <tr key={`${it.id}:${d.field}`} className={d.reason === 'locked' ? styles.rowLocked : undefined}>
                      {i === 0 && <td rowSpan={rows.length} className={styles.cellPath} title={it.relPath ?? it.audioFileId}>{it.relPath ?? it.audioFileId}</td>}
                      <td className={styles.cellField}>{d.field}</td>
                      <td className={styles.cellValue}>{fmtValue(d.before)}</td>
                      <td className={styles.cellValue}>{d.reason === 'locked' ? <em>kept (locked)</em> : fmtValue(d.after)}</td>
                      <td className={styles.cellWhy}>{d.reason.replace('policy:', '')}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {nothingToDo && (
        <div className={styles.previewInfo}>
          <p>Every file in scope already carries the canonical values under this policy. Nothing to apply.</p>
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.stepActions}>
        <button className={styles.btn} onClick={onBack}>
          Back
        </button>
        {previewed && (
          <button type="button" className={styles.btn} onClick={() => { setRequested(true); onPreview(); }} disabled={previewPending || requested}>
            Re-run preview
          </button>
        )}
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={onApply}
          disabled={isLoading || !canApply}
          title={applyTitle}
        >
          {isLoading ? 'Applying...' : 'Apply now'}
        </button>
      </div>
    </div>
  );
}

interface JobInfo {
  id: string;
  type: string;
  state: string;
  progress: { done: number; total: number; etaS?: number; message?: string };
  startedAt: string | undefined;
  finishedAt: string | undefined;
  error: string | null;
  createdAt: string;
}

function Step4Progress({
  job,
  planId,
  onClose,
  libraryId,
}: {
  job: JobInfo;
  planId: string;
  libraryId: string;
  onClose: () => void;
}) {
  const progress = job.progress || { done: 0, total: 0 };
  const percentage = progress.total > 0 ? ((progress.done / progress.total) * 100) : 0;
  const pauseMutation = usePauseTagPlan(libraryId, planId);
  const resumeMutation = useResumeTagPlan(libraryId, planId);
  const cancelMutation = useCancelTagPlan(libraryId, planId);
  const revertMutation = useRevertTagPlan(libraryId, planId);

  const isRunning = job.state === 'active';
  const isPaused = job.state === 'paused';
  const isFinished = job.state === 'completed' || job.state === 'failed';

  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Step 4: Apply in progress</p>

      <div className={styles.progressSection}>
        <div className={styles.progressBar}>
          <div
            className={styles.progressFill}
            style={{ width: `${percentage}%` }}
          />
        </div>
        <p className={styles.progressText}>
          {progress.message || `${progress.done} / ${progress.total} files`}
        </p>
      </div>

      {isRunning && (
        <div className={styles.stepActions}>
          <button
            className={styles.btn}
            onClick={() => pauseMutation.mutate()}
          >
            Pause
          </button>
          <button
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={() => cancelMutation.mutate()}
          >
            Cancel
          </button>
        </div>
      )}

      {isPaused && (
        <div className={styles.stepActions}>
          <button
            className={styles.btn}
            onClick={() => resumeMutation.mutate()}
          >
            Resume
          </button>
          <button
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={() => cancelMutation.mutate()}
          >
            Cancel
          </button>
        </div>
      )}

      {isFinished && (
        <div className={styles.finishedSection}>
          <p className={`${styles.status} ${job.state === 'completed' ? styles.statusSuccess : styles.statusError}`}>
            {job.state === 'completed' ? '✓ Plan applied' : '✗ Plan failed'}
          </p>
          <div className={styles.stepActions}>
            <button
              className={`${styles.btn} ${styles.btnSecondary}`}
              onClick={() => revertMutation.mutate()}
            >
              Revert this plan
            </button>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={onClose}
            >
              Done
            </button>
          </div>
        </div>
      )}
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
