import { useEffect, useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  autoAcceptRulesSchema,
  type AutoAcceptPreview, type AutoAcceptRules, type AutoAcceptSource, type AutoAcceptView,
} from '@liner/shared';
import { api } from '../../services/api';
import { Button, Input, SegmentedControl, Select, showToast, type SegmentedOption } from '../../components/ui';
import { ReviewDialog } from './ReviewDialog';
import styles from './review.module.css';

const ON_OFF: SegmentedOption<'on' | 'off'>[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

function OnOff({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return <SegmentedControl size="sm" label={label} options={ON_OFF} value={value ? 'on' : 'off'} onChange={(v) => onChange(v === 'on')} />;
}

function Rule({ title, hint, children, htmlFor }: { title: string; hint: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className={styles.rule}>
      <div className={styles.ruleText}>
        {htmlFor ? <label htmlFor={htmlFor} className={styles.ruleTitle}>{title}</label> : <p className={styles.ruleTitle}>{title}</p>}
        <p className={styles.ruleHint}>{hint}</p>
      </div>
      <div className={styles.ruleControl}>{children}</div>
    </div>
  );
}

/** Text in a number field, as an integer or NaN. */
const toInt = (s: string) => (/^\s*\d+\s*$/.test(s) ? parseInt(s, 10) : Number.NaN);

/**
 * The owner's auto-accept rules: what they are, a live dry-run count of the
 * queue, what they accepted lately, Save, and "Accept N now".
 */
export function AutoAcceptDialog({ libraryId, view, onClose }: { libraryId: string; view: AutoAcceptView; onClose: () => void }) {
  const queryClient = useQueryClient();
  const ids = { min: useId(), gap: useId(), source: useId() };
  const [enabled, setEnabled] = useState(view.rules.enabled);
  const [minMatch, setMinMatch] = useState(String(view.rules.minMatch));
  const [allChecksAgree, setAllChecksAgree] = useState(view.rules.allChecksAgree);
  const [gap, setGap] = useState(String(view.rules.clearWinnerGap));
  const [preferSource, setPreferSource] = useState<AutoAcceptSource>(view.rules.preferSource);
  const [officialOnly, setOfficialOnly] = useState(view.rules.officialOnly);

  const draft = { enabled, minMatch: toInt(minMatch), allChecksAgree, clearWinnerGap: toInt(gap), preferSource, officialOnly };
  const parsed = autoAcceptRulesSchema.safeParse(draft);
  const rules: AutoAcceptRules | null = parsed.success ? parsed.data : null;
  const minError = Number.isNaN(draft.minMatch) || draft.minMatch < 50 || draft.minMatch > 100 ? 'From 50 to 100.' : null;
  const gapError = Number.isNaN(draft.clearWinnerGap) || draft.clearWinnerGap < 0 || draft.clearWinnerGap > 50 ? 'From 0 to 50.' : null;

  // The count follows the form, a beat after the last change.
  const [counted, setCounted] = useState<AutoAcceptRules | null>(rules);
  const rulesKey = rules ? JSON.stringify(rules) : null;
  useEffect(() => {
    if (!rulesKey) return;
    const t = setTimeout(() => setCounted(JSON.parse(rulesKey) as AutoAcceptRules), 250);
    return () => clearTimeout(t);
  }, [rulesKey]);
  const preview = useQuery({
    queryKey: ['auto-accept-preview', libraryId, counted],
    queryFn: () => api.post<AutoAcceptPreview>(`/libraries/${libraryId}/auto-accept/preview`, counted),
    enabled: !!counted,
    placeholderData: (prev) => prev,
  });
  const stale = !rules || JSON.stringify(rules) !== JSON.stringify(counted) || preview.isFetching;
  const wouldAccept = preview.data?.wouldAccept ?? 0;

  const save = useMutation({
    mutationFn: (r: AutoAcceptRules) => api.put<AutoAcceptView>(`/libraries/${libraryId}/auto-accept`, r),
    onSuccess: (next) => queryClient.setQueryData(['auto-accept', libraryId], next),
  });
  const run = useMutation({
    mutationFn: () => api.post<{ jobId: string | null }>(`/libraries/${libraryId}/auto-accept/run`, {}),
  });
  const error = (save.error ?? run.error) as { detail?: string } | null;

  // Errors stay in the dialog (formError below); nothing to do here.
  const onSave = async () => {
    if (!rules) return;
    try {
      await save.mutateAsync(rules);
      onClose();
    } catch { /* shown in the dialog */ }
  };
  const onAcceptNow = async () => {
    if (!rules) return;
    try {
      await save.mutateAsync(rules);
      await run.mutateAsync();
      showToast({ message: `Accepting ${wouldAccept} ${wouldAccept === 1 ? 'album' : 'albums'} with your rules…` });
      onClose();
    } catch { /* shown in the dialog */ }
  };

  return (
    <ReviewDialog
      title="Auto-accept rules"
      onClose={onClose}
      wide
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" onClick={() => void onAcceptNow()} disabled={!rules || stale || wouldAccept === 0} loading={run.isPending}>
          {`Accept ${stale ? '…' : wouldAccept} now`}
        </Button>
        <Button onClick={() => void onSave()} disabled={!rules} loading={save.isPending && !run.isPending}>Save</Button>
      </>}
    >
      <div className={styles.rules}>
        <Rule title="Accept automatically" hint="Applies these rules to new matches.">
          <OnOff label="Accept automatically" value={enabled} onChange={setEnabled} />
        </Rule>
        <Rule title="Match at least" hint="The edition's overall match." htmlFor={ids.min}>
          <span className={styles.numberField}>
            <Input id={ids.min} dense inputMode="numeric" className={styles.number} value={minMatch} onChange={(e) => setMinMatch(e.target.value)} aria-invalid={!!minError} aria-describedby={minError ? `${ids.min}-err` : undefined} />
            <span aria-hidden="true">%</span>
          </span>
          {minError && <span id={`${ids.min}-err`} className={styles.fieldError}>{minError}</span>}
        </Rule>
        <Rule title="Every check agrees" hint="Album, artist, year and tracks.">
          <OnOff label="Every check agrees" value={allChecksAgree} onChange={setAllChecksAgree} />
        </Rule>
        <Rule title="Clear winner" hint="The next edition is at least this far behind. 0 skips this check." htmlFor={ids.gap}>
          <span className={styles.numberField}>
            <Input id={ids.gap} dense inputMode="numeric" className={styles.number} value={gap} onChange={(e) => setGap(e.target.value)} aria-invalid={!!gapError} aria-describedby={gapError ? `${ids.gap}-err` : undefined} />
            <span aria-hidden="true">points</span>
          </span>
          {gapError && <span id={`${ids.gap}-err`} className={styles.fieldError}>{gapError}</span>}
        </Rule>
        <Rule title="Prefer source" hint="When both list the edition." htmlFor={ids.source}>
          <Select id={ids.source} dense value={preferSource} onChange={(e) => setPreferSource(e.target.value as AutoAcceptSource)}>
            <option value="musicbrainz">MusicBrainz</option>
            <option value="discogs">Discogs</option>
            <option value="either">Either</option>
          </Select>
        </Rule>
        <Rule title="Official releases only" hint="Skips bootlegs, promos and withdrawn releases.">
          <OnOff label="Official releases only" value={officialOnly} onChange={setOfficialOnly} />
        </Rule>
      </div>

      <p className={styles.would} aria-live="polite">
        {!rules ? 'Fix the highlighted values to count the queue.'
          : preview.data ? <><b>{stale ? '…' : `${preview.data.wouldAccept} of ${preview.data.total}`}</b> albums in the queue would be accepted now.</>
          : preview.isError ? 'Could not count the queue.' : 'Counting the queue…'}
      </p>

      {view.acceptedTotal > 0 && (
        <details className={styles.recent}>
          <summary>Accepted by these rules · {view.acceptedTotal}</summary>
          <ul>
            {view.recent.map((r) => (
              <li key={`${r.albumId}-${r.decidedAt}`}>
                <Link to="/albums/$albumId" params={{ albumId: r.albumId }}>{r.title ?? 'Untitled'}</Link>
                <span>{[r.artist, `${r.percent}%`, new Date(r.decidedAt).toLocaleDateString()].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && <p className={styles.formError} role="alert">{error.detail ?? 'Could not save the rules.'}</p>}
    </ReviewDialog>
  );
}
