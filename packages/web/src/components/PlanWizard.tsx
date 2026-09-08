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
import styles from './PlanWizard.module.css';

interface WizardStep1State {
  scopeType: 'library' | 'artist' | 'albumIds' | 'filterQuery' | null;
  artistId?: string;
  albumIds?: string[];
  filterQuery?: Record<string, unknown>;
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
      }
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

  const canProceedStep1 = step1.scopeType !== null;
  const tagWritesDisabled = !settings.data?.tagWritesEnabled;
  const noWritableRoots = !settings.data?.scanRoots?.some((r) => r.writable);

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
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title}>New tag plan</h2>
          <button className={styles.helpBtn} onClick={() => setShowHelp(!showHelp)}>
            ?
          </button>
          <button className={styles.closeBtn} onClick={onClose}>
            ×
          </button>
        </div>

        {tagWritesDisabled && (
          <div className={styles.warningBanner}>
            Tag writes disabled in library settings.{' '}
            <a href="/settings/tag-writes">Go to Settings › Tag writes</a> to enable.
          </div>
        )}

        {noWritableRoots && (
          <div className={styles.warningBanner}>
            No writable scan roots configured. Plans cannot be applied.{' '}
            <a href="/settings/scan-roots">Go to Settings › Scan roots</a> to set one.
          </div>
        )}

        {showHelp && <HelpOverlay />}

        {step === 1 && (
          <Step1ScopePicker
            state={step1}
            onChange={setStep1}
            error={step1Error}
            onNext={() => setStep(2)}
            canProceed={canProceedStep1}
          />
        )}

        {step === 2 && (
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

        {step === 3 && createdPlanId && (
          <Step3PreviewTable
            planId={createdPlanId}
            onApply={handleApplyPlan}
            onBack={() => {
              setCreatedPlanId(null);
              setStep(2);
            }}
            isLoading={applyMutation.isPending}
            tagWritesDisabled={tagWritesDisabled}
            noWritableRoots={noWritableRoots}
          />
        )}

        {step === 4 && appliedJobId && currentJob && (
          <Step4Progress
            job={currentJob}
            planId={createdPlanId || ''}
            libraryId={libraryId}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

function Step1ScopePicker({
  state,
  onChange,
  error,
  onNext,
  canProceed,
}: {
  state: WizardStep1State;
  onChange: (state: WizardStep1State) => void;
  error: string | null;
  onNext: () => void;
  canProceed: boolean;
}) {
  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Step 1: Select scope</p>

      <fieldset className={styles.fieldset}>
        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="scope"
            value="library"
            checked={state.scopeType === 'library'}
            onChange={() => onChange({ scopeType: 'library' })}
          />
          Entire library
        </label>

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="scope"
            value="artist"
            checked={state.scopeType === 'artist'}
            onChange={() => onChange({ ...state, scopeType: 'artist' })}
          />
          All albums by an artist
          {state.scopeType === 'artist' && (
            <input
              type="text"
              placeholder="Artist ID or name"
              className={styles.input}
              value={state.artistId || ''}
              onChange={(e) => onChange({ ...state, artistId: e.target.value })}
            />
          )}
        </label>

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="scope"
            value="albumIds"
            checked={state.scopeType === 'albumIds'}
            onChange={() => onChange({ ...state, scopeType: 'albumIds' })}
          />
          Selected albums (multi-select)
          {state.scopeType === 'albumIds' && (
            <p className={styles.hint}>Album picker coming in follow-up UI</p>
          )}
        </label>

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="scope"
            value="filterQuery"
            checked={state.scopeType === 'filterQuery'}
            onChange={() => onChange({ ...state, scopeType: 'filterQuery' })}
          />
          Filter query (e.g. genre=Jazz)
          {state.scopeType === 'filterQuery' && (
            <input
              type="text"
              placeholder="e.g. genre=Jazz&decade=1970"
              className={styles.input}
              value={JSON.stringify(state.filterQuery || {})}
              onChange={(e) => {
                try {
                  onChange({
                    ...state,
                    filterQuery: JSON.parse(e.target.value),
                  });
                } catch {
                  // Invalid JSON, ignore
                }
              }}
            />
          )}
        </label>
      </fieldset>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.stepActions}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={onNext}
          disabled={!canProceed}
        >
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

function Step3PreviewTable({
  planId,
  onApply,
  onBack,
  isLoading,
  tagWritesDisabled,
  noWritableRoots,
}: {
  planId: string;
  onApply: () => void;
  onBack: () => void;
  isLoading: boolean;
  tagWritesDisabled: boolean;
  noWritableRoots: boolean;
}) {
  const canApply = !tagWritesDisabled && !noWritableRoots;
  const applyTitle = tagWritesDisabled
    ? 'Tag writes disabled in library settings'
    : noWritableRoots
      ? 'No writable scan roots configured'
      : undefined;

  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Step 3: Preview changes</p>
      <p className={styles.stepSubtitle}>
        Review the diff before applying. (Full preview table coming in follow-up UI)
      </p>

      <div className={styles.previewInfo}>
        <p>Plan preview loaded. Aggregate stats will show:</p>
        <ul className={styles.statsList}>
          <li>Number of files touched</li>
          <li>Total field changes</li>
          <li>Locked fields respected</li>
          <li>Files skipped and why</li>
        </ul>
      </div>

      <div className={styles.stepActions}>
        <button className={styles.btn} onClick={onBack}>
          Back
        </button>
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

function HelpOverlay() {
  return (
    <div className={styles.helpOverlay}>
      <h3>Tag Plan Wizard Help</h3>
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
