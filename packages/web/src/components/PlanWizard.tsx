/**
 * Tag plan wizard (XO-358)
 * When plans exist that have not been applied yet, it first asks whether to
 * add to one of them or start a new plan (from the album page the album is
 * already chosen). A new plan then takes two steps:
 * Step 1: Scope picker (library/artist/albums/query)
 * Step 2: Policy preset picker
 */

import { Fragment, useState, useCallback, useEffect, useId, useRef } from 'react';
import type { TagPlan, TagPlanScope, TagPolicies, CreateTagPlan } from '@liner/shared';
import { useNavigate, Link } from '@tanstack/react-router';
import { Button, Badge, Banner } from '../components/ui';
import { useCreateTagPlan, useLibrarySettings, useAddToTagPlan, useOpenTagPlans } from '../hooks/usePlanWizard';
import { useCurrentLibrary } from '../hooks';
import { useArtistsList } from '../hooks/useArtists';
import { useAlbums, useScanRoots } from '../hooks/useLibrary';
import { IconButton } from './ui';
import { planDoneNavigation } from './planWizardHistory';
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
type WizardMode = 'new-plan' | 'add-to-plan';

interface PlanWizardProps {
  libraryId: string;
  onClose: () => void;
  /** Open already scoped to these albums (album page "Fix tags"); lands on step 2. */
  initialScope?: { albumIds: string[]; albumLabels?: Record<string, string> };
  /** Called once the plan exists, just before the wizard moves on to the plan page. */
  onDone?: () => void;
  /**
   * The current history entry exists only to show this wizard (/plans?album=):
   * moving on to the plan page replaces it, so Back never reopens a finished wizard.
   */
  replaceHistoryOnDone?: boolean;
}

/** Plain words for why adding to a plan failed; the server's text stays in the log. */
function addToPlanErrorMessage(error: unknown): string {
  switch ((error as { status?: number } | null)?.status) {
    case 409: return 'That plan can no longer take albums: it has been applied, or it is not a list of albums. Start a new plan instead.';
    case 404: return 'That plan no longer exists. Pick another one or start a new plan.';
    case 400: return 'This album could not be added to that plan. Reload the page and try again.';
    default: return 'Could not add to the plan. Try again.';
  }
}

function createPlanErrorMessage(error: unknown): string {
  const e = error as { status?: number; detail?: string } | null;
  // The create route's 400s are written for people ("The filter matches no albums").
  if (e?.status === 400 && e.detail && e.detail !== 'Request validation failed') return e.detail;
  return 'Could not create the plan. Try again.';
}

export function PlanWizard({ libraryId, onClose, initialScope, onDone, replaceHistoryOnDone = false }: PlanWizardProps) {
  // null until the user picks: add to an open plan, or start a new one. When
  // there is no open plan to add to, the choice is skipped (see effectiveMode).
  const [mode, setMode] = useState<WizardMode | null>(null);
  const [step, setStep] = useState<WizardStep>(initialScope ? 2 : 1);
  const [planName, setPlanName] = useState('');
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [step1, setStep1] = useState<WizardStep1State>(
    initialScope
      ? { scopeType: 'albumIds', albumIds: initialScope.albumIds, ...(initialScope.albumLabels ? { albumLabels: initialScope.albumLabels } : {}) }
      : { scopeType: null },
  );
  const [step2, setStep2] = useState<WizardStep2State>({
    preset: 'canonical_ids_and_fill',
    id3Version: '2.4',
    multiValueSeparator: '; ',
  });

  const openPlansQ = useOpenTagPlans(libraryId);
  const openPlans: TagPlan[] = openPlansQ.data?.items ?? [];
  const openPlansTotal = openPlansQ.data?.total ?? 0;
  // A failed list is treated as "nothing to add to": starting a new plan still works.
  const openPlansSettled = openPlansQ.isSuccess || openPlansQ.isError;
  const hasOpenPlans = openPlans.length > 0;
  const effectiveMode: WizardMode | null = mode ?? (openPlansSettled && !hasOpenPlans ? 'new-plan' : null);
  const backToChoice = hasOpenPlans
    ? () => {
        setMode(null);
        setStep(initialScope ? 2 : 1);
        setStep1Error(null);
      }
    : undefined;
  // A plan is named after what it covers unless the user types a name;
  // "New tag plan" x 12 in the list told nobody anything.
  const suggestedName = (() => {
    switch (step1.scopeType) {
      case 'artist': return step1.artistName ? `${step1.artistName} tags` : 'Artist tags';
      case 'albumIds': {
        const ids = step1.albumIds ?? [];
        if (ids.length === 1) return `${step1.albumLabels?.[ids[0]!] ?? '1 album'} tags`;
        return `${ids.length} albums tags`;
      }
      case 'filterQuery': return 'Filtered albums tags';
      case 'library': return 'Whole library tags';
      default: return 'New tag plan';
    }
  })();
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  // What step 1 chose, in a few words, for the step indicator.
  const scopeSummary = (() => {
    switch (step1.scopeType) {
      case 'artist': return step1.artistName ?? 'An artist';
      case 'albumIds': {
        const ids = step1.albumIds ?? [];
        if (ids.length === 1) return step1.albumLabels?.[ids[0]!] ?? '1 album';
        return `${ids.length} albums`;
      }
      case 'filterQuery': return 'Albums matching a filter';
      case 'library': return 'Entire library';
      default: return null;
    }
  })();

  const settings = useLibrarySettings(libraryId);
  const scanRoots = useScanRoots(libraryId);
  // New plans start from the library's default policy (Settings › Tag writes);
  // applied once when settings arrive, before the user reaches step 2.
  const [policySeeded, setPolicySeeded] = useState(false);
  useEffect(() => {
    if (policySeeded || !settings.data?.tagPolicy) return;
    const p = settings.data.tagPolicy;
    setStep2({
      preset: p.preset === 'manual' || p.preset === 'revert' ? 'canonical_ids_and_fill' : p.preset,
      id3Version: p.id3Version,
      multiValueSeparator: p.multiValueSeparator,
      ...(p.overrides ? { overrides: p.overrides } : {}),
    });
    setPolicySeeded(true);
  }, [policySeeded, settings.data]);
  const navigate = useNavigate();
  const createPlanMutation = useCreateTagPlan(libraryId);
  const addToPlanMutation = useAddToTagPlan(libraryId);

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
      setStep1Error('Pick what the plan should cover first.');
      return;
    }

    const policy = buildPolicy();
    const payload: CreateTagPlan = {
      name: planName.trim() || suggestedName,
      scope,
      policy,
    };

    try {
      const result = await createPlanMutation.mutateAsync(payload);
      // The plan page runs the preview and shows the diff at full width.
      // No onClose here: the route change unmounts the wizard, and a parent
      // whose close navigates (dropping ?album=) would race this navigation.
      onDone?.();
      void navigate(planDoneNavigation(result.id, replaceHistoryOnDone));
    } catch (error) {
      setStep1Error(createPlanErrorMessage(error));
    }
  };

  const handleAddToPlan = async (planId: string | null) => {
    const albumIds = step1.scopeType === 'albumIds' ? step1.albumIds ?? [] : [];
    if (!planId) {
      setStep1Error('Pick a plan first.');
      return;
    }
    if (albumIds.length === 0) {
      setStep1Error('Pick at least one album to add.');
      return;
    }
    try {
      await addToPlanMutation.mutateAsync({ planId, albumIds });
      // The plan page follows the fresh preview the server queued.
      onDone?.();
      void navigate(planDoneNavigation(planId, replaceHistoryOnDone));
    } catch (error) {
      setStep1Error(addToPlanErrorMessage(error));
    }
  };

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Escape closes the shortcuts popover first, the wizard after.
        if (showShortcuts) setShowShortcuts(false);
        else onClose();
        return;
      }
      // Typing into a search box must not toggle the shortcuts or jump a step.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '?') {
        setShowShortcuts((s) => !s);
        return;
      }
      if (e.key === 'Enter' && effectiveMode === 'new-plan') {
        // Enter advances; on the last step it creates the plan. The choice
        // and add steps submit through their own buttons.
        if (step === 1 && canProceedStep1) setStep(2);
        else if (step === 2) void handleCreatePlan();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [step, step1, effectiveMode, canProceedStep1, onClose, showShortcuts]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const title = effectiveMode === 'add-to-plan' ? 'Add to a plan' : effectiveMode === 'new-plan' ? 'New tag plan' : initialScope ? 'Fix tags' : 'Tag plan';
  const albumLabel = initialScope
    ? initialScope.albumIds.length === 1
      ? initialScope.albumLabels?.[initialScope.albumIds[0]!] ?? 'this album'
      : `these ${initialScope.albumIds.length} albums`
    : null;

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <div className={styles.headerActions}>
            <ShortcutsPopover open={showShortcuts} onOpenChange={setShowShortcuts} />
            <IconButton variant="quiet" size="sm" label="Close" onClick={onClose} title="Close (Esc)">
              <CloseGlyph />
            </IconButton>
          </div>
        </div>

        <div className={styles.body}>
          {(tagWritesDisabled || noWritableRoots) && (
            <Banner tone="warning">
              <strong>Plans preview, but cannot apply yet.</strong>
              <ul style={{ margin: '0.4rem 0 0 0', paddingLeft: '1.1rem' }}>
                {tagWritesDisabled && (
                  <li>
                    Tag writes are off — <Link to="/settings/$section" params={{ section: 'metadata' }}>Settings › Tag preferences › Tag writes</Link>
                  </li>
                )}
                {noWritableRoots && (
                  <li>
                    No scan root allows writes — <Link to="/settings/library">Settings › Music folders</Link>
                  </li>
                )}
              </ul>
            </Banner>
          )}

        {effectiveMode === null && !openPlansSettled && (
          <p className={styles.stepSubtitle}>Loading your plans…</p>
        )}

        {effectiveMode === null && openPlansSettled && (
          <StepChoosePlan
            albumLabel={albumLabel}
            albumIds={initialScope?.albumIds ?? []}
            openPlans={openPlans}
            openPlansTotal={openPlansTotal}
            error={step1Error}
            isLoading={addToPlanMutation.isPending}
            onAddTo={(planId) => {
              setStep1Error(null);
              if (initialScope) {
                void handleAddToPlan(planId);
              } else {
                setSelectedPlanId(planId);
                setMode('add-to-plan');
              }
            }}
            onNew={() => {
              setStep1Error(null);
              setMode('new-plan');
            }}
          />
        )}

        {effectiveMode === 'add-to-plan' && (
          <StepPickAlbumsForPlan
            libraryId={libraryId}
            plan={openPlans.find((p) => p.id === selectedPlanId) ?? null}
            state={step1}
            onChange={(s) => setStep1({ ...s, scopeType: 'albumIds' })}
            error={step1Error}
            onNext={() => void handleAddToPlan(selectedPlanId)}
            onBack={() => {
              setSelectedPlanId(null);
              backToChoice?.();
            }}
            isLoading={addToPlanMutation.isPending}
          />
        )}

        {effectiveMode === 'new-plan' && (
          <StepIndicator
            step={step}
            scopeSummary={canProceedStep1 ? scopeSummary : null}
            onPick={(s) => {
              if (s === 1) setStep(1);
              else if (canProceedStep1) setStep(2);
            }}
          />
        )}

        {effectiveMode === 'new-plan' && step === 1 && (
          <Step1ScopePicker
            libraryId={libraryId}
            state={step1}
            onChange={setStep1}
            error={step1Error}
            onNext={() => setStep(2)}
            canProceed={canProceedStep1}
            {...(backToChoice ? { onBack: backToChoice } : {})}
          />
        )}

        {effectiveMode === 'new-plan' && step === 2 && (
          <Step2PolicyPicker
            state={step2}
            onChange={setStep2}
            planName={planName}
            suggestedName={suggestedName}
            onPlanNameChange={setPlanName}
            error={step1Error}
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

const PLAN_STATUS_LABEL: Record<string, string> = { draft: 'Preview not run yet', previewed: 'Preview ready' };

/** True when the plan is a list of albums that already has every one of these. */
export function planIncludesAll(plan: TagPlan, albumIds: string[]): boolean {
  if (albumIds.length === 0 || plan.scope.type !== 'albumIds') return false;
  const inPlan = new Set(plan.scope.albumIds);
  return albumIds.every((id) => inPlan.has(id));
}

/**
 * First step when there are plans that have not been applied yet: add to one
 * of them, or start a new plan. From the album page the album is already
 * chosen, so picking a plan adds it straight away.
 */
function StepChoosePlan({
  albumLabel,
  albumIds,
  openPlans,
  openPlansTotal,
  error,
  isLoading,
  onAddTo,
  onNew,
}: {
  /** "Artist — Title" when opened from an album page; null from the plans page */
  albumLabel: string | null;
  /** the albums being fixed, to mark plans that already include them */
  albumIds: string[];
  openPlans: TagPlan[];
  openPlansTotal: number;
  error: string | null;
  isLoading: boolean;
  onAddTo: (planId: string) => void;
  onNew: () => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const addingTo = choice && choice !== 'new' ? choice : null;
  const firstPickable = openPlans.find((p) => !planIncludesAll(p, albumIds))?.id;
  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>
        {albumLabel ? <>Where should the tag fixes for {albumLabel} go?</> : 'Start a new plan, or add albums to one you have not applied yet?'}
      </p>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Add to a plan you have not applied yet</legend>
        {openPlans.map((plan) => {
          // Adding an album a plan already covers would change nothing, so
          // that plan cannot be picked; the note says why.
          const already = planIncludesAll(plan, albumIds);
          return (
            <label key={plan.id} className={`${styles.radioLabel} ${already ? styles.radioLabelDisabled : ''}`}>
              <input
                type="radio"
                name="plan-choice"
                value={plan.id}
                checked={choice === plan.id}
                disabled={already}
                onChange={() => setChoice(plan.id)}
                autoFocus={plan.id === firstPickable}
              />
              <span className={styles.choiceText}>
                <span>{plan.name || 'Untitled plan'}</span>
                <span className={styles.choiceMeta}>
                  {[plan.scopeLabel, PLAN_STATUS_LABEL[plan.status]].filter(Boolean).join(' · ')}
                </span>
                {already && (
                  <span className={styles.choiceNote}>
                    Already includes {albumIds.length === 1 ? 'this album' : 'these albums'}
                  </span>
                )}
              </span>
            </label>
          );
        })}
        {openPlansTotal > openPlans.length && (
          <p className={styles.choiceMeta}>
            Showing the {openPlans.length} newest of {openPlansTotal.toLocaleString()} plans you have not applied yet.
          </p>
        )}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Or</legend>
        <label className={styles.radioLabel}>
          <input type="radio" name="plan-choice" value="new" checked={choice === 'new'} onChange={() => setChoice('new')} />
          <span className={styles.choiceText}>
            <span>Start a new plan</span>
            <span className={styles.choiceMeta}>
              {albumLabel ? 'Choose how the tags are fixed for this album on its own.' : 'Choose which albums it covers and how tags are fixed.'}
            </span>
          </span>
        </label>
      </fieldset>

      {error && <Banner tone="danger">{error}</Banner>}

      <div className={styles.stepActions}>
        <Button
          variant="primary"
          disabled={!choice || isLoading}
          loading={isLoading}
          onClick={() => {
            if (choice === 'new') onNew();
            else if (addingTo) onAddTo(addingTo);
          }}
        >
          {choice === 'new' ? 'Next' : albumLabel ? (isLoading ? 'Adding…' : 'Add to plan') : 'Next'}
        </Button>
      </div>
    </div>
  );
}

/** From the plans page: pick the albums to add to the chosen plan. */
function StepPickAlbumsForPlan({
  libraryId,
  plan,
  state,
  onChange,
  error,
  onNext,
  onBack,
  isLoading,
}: {
  libraryId: string;
  plan: TagPlan | null;
  state: WizardStep1State;
  onChange: (state: WizardStep1State) => void;
  error: string | null;
  onNext: () => void;
  onBack: () => void;
  isLoading: boolean;
}) {
  const canProceed = !!plan && (state.albumIds?.length ?? 0) > 0;

  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Albums to add to {plan?.name || 'this plan'}</p>
      <p className={styles.stepSubtitle}>The plan's preview runs again with these albums included.</p>

      <AlbumPicker
        libraryId={libraryId}
        selectedIds={state.albumIds ?? []}
        labels={state.albumLabels ?? {}}
        onChange={(albumIds, albumLabels) => onChange({ ...state, albumIds, albumLabels })}
        alreadyIn={plan?.scope.type === 'albumIds' ? plan.scope.albumIds : []}
      />

      {error && <Banner tone="danger">{error}</Banner>}

      <div className={styles.stepActions}>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" onClick={onNext} disabled={!canProceed || isLoading} loading={isLoading}>
          {isLoading ? 'Adding…' : 'Add to plan'}
        </Button>
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
  alreadyIn = [],
}: {
  libraryId: string;
  selectedIds: string[];
  labels: Record<string, string>;
  onChange: (ids: string[], labels: Record<string, string>) => void;
  /** albums the target plan already covers: shown, but cannot be ticked */
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
            const inPlan = alreadyIn.includes(al.id);
            const checked = inPlan || selectedIds.includes(al.id);
            return (
              <li key={al.id}>
                <label className={`${styles.comboItem} ${checked ? styles.comboItemChecked : ''} ${inPlan ? styles.comboItemDisabled : ''}`}>
                  <input type="checkbox" checked={checked} disabled={inPlan} onChange={() => toggle(al.id, label)} />
                  <span>{label}</span>
                  <span className={styles.comboMeta}>
                    {inPlan ? 'Already in this plan' : `${al.year ?? '—'} · ${al.trackCount} tracks · ${al.formats.join('/')}`}
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
  onBack,
}: {
  libraryId: string;
  state: WizardStep1State;
  onChange: (state: WizardStep1State) => void;
  error: string | null;
  onNext: () => void;
  canProceed: boolean;
  onBack?: () => void;
}) {
  const pick = (scopeType: WizardStep1State['scopeType']) => onChange({ ...state, scopeType });
  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>What should the plan cover?</p>

      <fieldset className={styles.fieldset}>
        <label className={styles.radioLabel}>
          <input type="radio" name="scope" value="library" checked={state.scopeType === 'library'} onChange={() => pick('library')} />
          <span className={styles.choiceText}>
              <span>Entire library</span>
              <span className={styles.choiceMeta}>Every album in the library.</span>
            </span>
        </label>

        <div className={styles.scopeBlock}>
          <label className={styles.radioLabel}>
            <input type="radio" name="scope" value="artist" checked={state.scopeType === 'artist'} onChange={() => pick('artist')} />
            <span className={styles.choiceText}>
              <span>All albums by an artist</span>
              <span className={styles.choiceMeta}>Albums credited to one identified artist.</span>
            </span>
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
            <span className={styles.choiceText}>
              <span>Selected albums</span>
              <span className={styles.choiceMeta}>Search and tick the albums to include.</span>
            </span>
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
            <span className={styles.choiceText}>
              <span>Albums matching a filter</span>
              <span className={styles.choiceMeta}>The same filters as the album grid, e.g. genre=Jazz.</span>
            </span>
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

      {error && <Banner tone="danger">{error}</Banner>}

      <div className={styles.stepActions}>
        {onBack && (
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
        )}
        <Button variant="primary" onClick={onNext} disabled={!canProceed}>
          Next
        </Button>
      </div>
    </div>
  );
}

function Step2PolicyPicker({
  state,
  onChange,
  planName,
  suggestedName,
  onPlanNameChange,
  error,
  onNext,
  onBack,
  isLoading,
}: {
  state: WizardStep2State;
  onChange: (state: WizardStep2State) => void;
  planName: string;
  suggestedName: string;
  onPlanNameChange: (name: string) => void;
  error: string | null;
  onNext: () => void;
  onBack: () => void;
  isLoading: boolean;
}) {
  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>How should the tags be fixed?</p>

      <div className={styles.formGroup}>
        <label className={styles.label} htmlFor="plan-wizard-name">Plan name</label>
        <input
          id="plan-wizard-name"
          type="text"
          className={styles.input}
          value={planName}
          onChange={(e) => onPlanNameChange(e.target.value)}
          placeholder={suggestedName}
        />
      </div>

      <fieldset className={`${styles.fieldset} ${styles.presetGrid}`}>
        <legend className={styles.legend}>Policy preset</legend>

        <label className={styles.presetCard}>
          <input
            type="radio"
            name="preset"
            value="canonical_ids_and_fill"
            checked={state.preset === 'canonical_ids_and_fill'}
            onChange={() => onChange({ ...state, preset: 'canonical_ids_and_fill' })}
          />
          <span className={styles.choiceText}>
            <span className={styles.choiceLabel}>Canonical IDs + fill (default)</span>
            <span className={styles.choiceMeta}>Overwrite ID tags and key fields; fill blanks for title, artist, genre, compilation</span>
          </span>
        </label>

        <label className={styles.presetCard}>
          <input
            type="radio"
            name="preset"
            value="fill_blanks_only"
            checked={state.preset === 'fill_blanks_only'}
            onChange={() => onChange({ ...state, preset: 'fill_blanks_only' })}
          />
          <span className={styles.choiceText}>
            <span className={styles.choiceLabel}>Fill blanks only</span>
            <span className={styles.choiceMeta}>Never overwrite; only set empty fields</span>
          </span>
        </label>

        <label className={styles.presetCard}>
          <input
            type="radio"
            name="preset"
            value="overwrite_all"
            checked={state.preset === 'overwrite_all'}
            onChange={() => onChange({ ...state, preset: 'overwrite_all' })}
          />
          <span className={styles.choiceText}>
            <span className={styles.choiceLabel}>Overwrite all</span>
            <span className={styles.choiceMeta}>Replace all canonical fields with new values</span>
          </span>
        </label>

        <label className={styles.presetCard}>
          <input
            type="radio"
            name="preset"
            value="custom"
            checked={state.preset === 'custom'}
            onChange={() => onChange({ ...state, preset: 'custom' })}
          />
          <span className={styles.choiceText}>
            <span className={styles.choiceLabel}>Custom (per-field rules)</span>
            <span className={styles.choiceMeta}>Advanced: configure each field individually</span>
          </span>
        </label>
      </fieldset>

      <div className={styles.formGroup}>
        <label className={styles.label} htmlFor="plan-wizard-id3">ID3 version (for MP3 files)</label>
        <select
          id="plan-wizard-id3"
          className={styles.select}
          value={state.id3Version}
          onChange={(e) => onChange({ ...state, id3Version: e.target.value as '2.3' | '2.4' })}
        >
          <option value="2.4">ID3 v2.4 UTF-8 (default, recommended)</option>
          <option value="2.3">ID3 v2.3 (legacy players)</option>
        </select>
      </div>

      {error && <Banner tone="danger">{error}</Banner>}

      <div className={styles.stepActions}>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          onClick={onNext}
          disabled={isLoading}
        >
          {isLoading ? 'Creating…' : 'Create plan & preview'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Where the user is in a new plan. From the album page the wizard opens on
 * step 2 with the album already chosen; step 1 still shows, done, with what
 * it holds, and can be reopened.
 */
function StepIndicator({
  step,
  scopeSummary,
  onPick,
}: {
  step: WizardStep;
  scopeSummary: string | null;
  onPick: (step: WizardStep) => void;
}) {
  const items: { n: WizardStep; label: string; detail: string | null }[] = [
    { n: 1, label: 'What it covers', detail: scopeSummary },
    { n: 2, label: 'How tags are fixed', detail: null },
  ];
  return (
    <ol className={styles.stepper} aria-label={`Step ${step} of ${items.length}`}>
      {items.map((it) => {
        const current = it.n === step;
        const done = it.n < step;
        const reachable = !current && (it.n === 1 || !!scopeSummary);
        const body = (
          <>
            <span className={styles.stepDot} aria-hidden="true">{done ? '✓' : it.n}</span>
            <span className={styles.stepText}>
              <span className={styles.stepName}>{it.label}</span>
              {done && it.detail && <span className={styles.stepDetail}>{it.detail}</span>}
            </span>
          </>
        );
        return (
          <li
            key={it.n}
            className={`${styles.stepItem} ${current ? styles.stepItemCurrent : ''} ${done ? styles.stepItemDone : ''}`}
            aria-current={current ? 'step' : undefined}
          >
            {reachable ? (
              <button type="button" className={styles.stepButton} onClick={() => onPick(it.n)}>
                {body}
              </button>
            ) : (
              <span className={styles.stepButton}>{body}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function HelpGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6.1a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.3v.3" />
      <circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export const WIZARD_SHORTCUTS: Array<[key: string, what: string]> = [
  ['Enter', 'Next step; on the last step, create the plan'],
  ['Esc', 'Close the wizard'],
  ['?', 'Show or hide these shortcuts'],
];

/**
 * The "?" in the header: a small popover with the keyboard shortcuts. It
 * floats over the wizard and never changes the modal's size; what each choice
 * means is written under the choice itself. Closes on Escape (handled by the
 * wizard, so Escape does not also close the wizard), a click outside, or "?".
 */
export function ShortcutsPopover({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, onOpenChange]);
  return (
    <div className={styles.shortcuts} ref={root}>
      <IconButton
        variant="quiet"
        size="sm"
        label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        aria-expanded={open}
        {...(open ? { 'aria-controls': id } : {})}
        onClick={() => onOpenChange(!open)}
      >
        <HelpGlyph />
      </IconButton>
      {open && (
        <div id={id} role="dialog" aria-label="Keyboard shortcuts" className={styles.shortcutsPop}>
          <p className={styles.shortcutsTitle}>Keyboard shortcuts</p>
          <dl className={styles.shortcutsList}>
            {WIZARD_SHORTCUTS.map(([k, what]) => (
              <Fragment key={k}>
                <dt><kbd className={styles.kbd}>{k}</kbd></dt>
                <dd>{what}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
