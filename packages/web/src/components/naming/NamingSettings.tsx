/**
 * Settings › Library › Naming (owner, 0081): where the rules put an album's
 * folder and its files. Until the owner saves, the rules shown are the ones
 * detected from the library (or the default). Examples follow the unsaved
 * rules as the owner types (POST naming/examples, debounced). The rules and
 * Leave alone are one draft, saved with the one Save (Reset drops it).
 * NamingSettingsView is the section alone, driven by props (stories, tests).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { NamingExample, NamingRulesInput, NamingView } from '@tagave/shared';
import { Button, Chip, CloseIcon, EmbossIconButton, Input, SettingsGroup, SettingsRow, SettingsSave, useSaveFlash, type SaveState } from '../ui';
import { useCurrentLibrary } from '../../hooks';
import { useNaming, useNamingExamples, useSaveNaming } from '../../hooks/useNaming';
import styles from './Naming.module.css';

const VARIABLES = ['{initial}', '{albumartist}', '{artist}', '{year}', '{album}', '{disc}', '{track:02}', '{title}', '{ext}', '[ ]'];

const SPECIAL_ORDER = ['soundtrack', 'compilation'] as const;

/** The rules with one special row per kind, soundtrack then compilation (empty folder: off). */
export function normalizeRules(rules: NamingRulesInput): NamingRulesInput {
  return {
    ...rules,
    special: SPECIAL_ORDER.map((when) => ({ when, folder: rules.special.find((s) => s.when === when)?.folder ?? '' })),
    leaveAlone: [...rules.leaveAlone],
  };
}

/** The view's problems with special.N renumbered to the order above. */
function viewProblems(view: NamingView): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(view.problems)) {
    const m = k.match(/^special\.(\d+)$/);
    if (!m) { out[k] = v; continue; }
    const when = view.rules.special[Number(m[1])]?.when;
    const i = SPECIAL_ORDER.findIndex((s) => s === when);
    out[i >= 0 ? `special.${i}` : k] = v;
  }
  return out;
}

const errorText = (err: unknown): string | null => (err as { detail?: string } | null)?.detail ?? null;

export function NamingSettings() {
  const { libraryId } = useCurrentLibrary();
  const naming = useNaming(libraryId);
  if (!naming.data) return null;
  return <NamingForm key={libraryId} libraryId={libraryId} view={naming.data} />;
}

function NamingForm({ libraryId, view }: { libraryId: string | undefined; view: NamingView }) {
  const save = useSaveNaming(libraryId);
  const examples = useNamingExamples(libraryId);
  const flash = useSaveFlash();
  return (
    <NamingSettingsView
      view={view}
      pending={save.isPending}
      state={flash.state}
      detail={flash.detail}
      onPreview={examples.mutateAsync}
      onSave={(rules, done) => {
        flash.clear();
        save.mutate(rules, {
          onSuccess: () => { done(); flash.saved(); },
          onError: (err) => flash.failed(errorText(err)),
        });
      }}
    />
  );
}

export interface NamingSettingsViewProps {
  view: NamingView;
  pending?: boolean;
  /** save; `done` drops the draft once saved */
  onSave: (rules: NamingRulesInput, done: () => void) => void;
  /** examples of unsaved rules (debounced); without it the saved examples stay */
  onPreview?: (rules: NamingRulesInput) => Promise<{ examples: NamingExample[]; problems: Record<string, string> }>;
  state?: SaveState;
  detail?: string | null;
}

export function NamingSettingsView({ view, pending = false, onSave, onPreview, state = null, detail = null }: NamingSettingsViewProps) {
  const [draft, setDraft] = useState<NamingRulesInput | null>(null);
  const [preview, setPreview] = useState<{ examples: NamingExample[]; problems: Record<string, string> } | null>(null);
  const [adding, setAdding] = useState('');
  const rules = draft ?? normalizeRules(view.rules);
  const problems = preview?.problems ?? viewProblems(view);
  const shown = preview?.examples ?? view.examples;

  // examples of the unsaved rules, 400 ms after the last keystroke; a late
  // answer to older rules is dropped
  const seq = useRef(0);
  useEffect(() => {
    if (!draft || !onPreview) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      onPreview(draft).then((r) => { if (n === seq.current) setPreview(r); }).catch(() => { /* the last examples stay */ });
    }, 400);
    return () => clearTimeout(t);
  }, [draft, onPreview]);

  const change = (next: Partial<NamingRulesInput>) => setDraft({ ...rules, ...next });
  const setSpecial = (i: number, folder: string) => change({ special: rules.special.map((s, j) => (j === i ? { ...s, folder } : s)) });
  const addLeaveAlone = () => {
    const v = adding.trim();
    if (!v) return;
    if (!rules.leaveAlone.includes(v)) change({ leaveAlone: [...rules.leaveAlone, v] });
    setAdding('');
  };
  const onAddKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addLeaveAlone();
  };
  const reset = () => { setDraft(null); setPreview(null); };

  const hasProblems = Object.keys(problems).length > 0;
  const canSave = (!!draft || !view.saved) && !hasProblems && !!rules.folder.trim() && !!rules.file.trim();
  const problemOf = (key: string) => (problems[key] ? <span className={styles.error}>{problems[key]}</span> : undefined);
  const special = (i: number) => (
    <Input
      dense
      className={`${styles.field} ${styles.mono}`}
      value={rules.special[i]?.folder ?? ''}
      placeholder="Off"
      spellCheck={false}
      autoComplete="off"
      aria-invalid={problems[`special.${i}`] ? true : undefined}
      onChange={(e) => setSpecial(i, e.currentTarget.value)}
    />
  );

  const variables = (
    <div className={styles.chips} aria-label="Variables">
      {VARIABLES.map((v) => <Chip key={v}><code>{v}</code></Chip>)}
    </div>
  );

  return (
    <div className={styles.section}>
      <SettingsGroup
        title="Naming"
        help={variables}
        after={(
          <div className={styles.buttons}>
            <SettingsSave dirty={canSave} pending={pending} onSave={() => onSave(rules, reset)} state={state} detail={detail} />
            <Button variant="quiet" size="sm" onClick={reset} disabled={!draft || pending}>Reset</Button>
          </div>
        )}
      >
        {!view.saved && (
          <SettingsRow as="div" label="Rules" value={<span className={styles.value}>{view.detected?.found ? `Detected · ${view.detected.matched.toLocaleString()} / ${view.detected.sampled.toLocaleString()}` : 'Default'}</span>} />
        )}
        <SettingsRow label="Folder" value={problemOf('folder')}>
          <Input dense className={`${styles.field} ${styles.mono}`} value={rules.folder} spellCheck={false} autoComplete="off" aria-invalid={problems.folder ? true : undefined} onChange={(e) => change({ folder: e.currentTarget.value })} />
        </SettingsRow>
        <SettingsRow label="File" value={problemOf('file')}>
          <Input dense className={`${styles.field} ${styles.mono}`} value={rules.file} spellCheck={false} autoComplete="off" aria-invalid={problems.file ? true : undefined} onChange={(e) => change({ file: e.currentTarget.value })} />
        </SettingsRow>
        <SettingsRow label="Soundtrack" value={problemOf('special.0')}>{special(0)}</SettingsRow>
        <SettingsRow label="Compilation" value={problemOf('special.1')}>{special(1)}</SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Leave alone" help="Folders that start with one of these keep their place">
        {rules.leaveAlone.map((p) => (
          <SettingsRow key={p} as="div" label={p}>
            <EmbossIconButton label={`Remove ${p}`} onClick={() => change({ leaveAlone: rules.leaveAlone.filter((x) => x !== p) })}><CloseIcon /></EmbossIconButton>
          </SettingsRow>
        ))}
        <SettingsRow as="div" label="Add a folder">
          <span className={styles.inline}>
            <Input dense aria-label="Folder to leave alone" value={adding} spellCheck={false} autoComplete="off" className={`${styles.field} ${styles.mono}`} onChange={(e) => setAdding(e.currentTarget.value)} onKeyDown={onAddKey} />
            <Button variant="secondary" size="sm" disabled={!adding.trim()} onClick={addLeaveAlone}>Add</Button>
          </span>
        </SettingsRow>
      </SettingsGroup>

      {shown.length > 0 ? (
        <SettingsGroup
          title="Examples"
          after={(
            <ul className={styles.examples} aria-live="polite">
              {shown.slice(0, 3).map((x) => (
                <li key={`${x.albumId}:${x.from}`} className={styles.example}>
                  <span className={styles.from}>{x.from}</span>
                  <span className={styles.to}>{x.to}</span>
                </li>
              ))}
            </ul>
          )}
        />
      ) : (
        <SettingsGroup title="Examples" meta="No examples" />
      )}
    </div>
  );
}
