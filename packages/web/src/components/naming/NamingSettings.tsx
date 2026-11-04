/**
 * Settings › Library › Naming (owner, 0081): where the rules put an album's
 * folder and its files. Until the owner saves, the rules shown are the ones
 * detected from the library (or the default). Examples follow the unsaved
 * rules as the owner types (POST naming/examples, debounced).
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { NamingExample, NamingRulesInput, NamingView } from '@tagave/shared';
import { Button, Chip, CloseIcon, EmbossIconButton, Input, TextField, showToast } from '../ui';
import { useCurrentLibrary } from '../../hooks';
import { useNaming, useNamingExamples, useSaveNaming } from '../../hooks/useNaming';
import styles from './Naming.module.css';

const SPECIAL: Array<{ when: 'soundtrack' | 'compilation'; label: string }> = [
  { when: 'soundtrack', label: 'Soundtrack' },
  { when: 'compilation', label: 'Compilation' },
];

const VARIABLES = ['{initial}', '{albumartist}', '{artist}', '{year}', '{album}', '{disc}', '{track:02}', '{title}', '{ext}', '[ ]'];

/** The rules with one special row per kind, in SPECIAL's order (empty folder: off). */
export function normalizeRules(rules: NamingRulesInput): NamingRulesInput {
  return {
    ...rules,
    special: SPECIAL.map(({ when }) => ({ when, folder: rules.special.find((s) => s.when === when)?.folder ?? '' })),
    leaveAlone: [...rules.leaveAlone],
  };
}

/** The view's problems with special.N renumbered to SPECIAL's order. */
function viewProblems(view: NamingView): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(view.problems)) {
    const m = k.match(/^special\.(\d+)$/);
    if (!m) { out[k] = v; continue; }
    const when = view.rules.special[Number(m[1])]?.when;
    const i = SPECIAL.findIndex((s) => s.when === when);
    out[i >= 0 ? `special.${i}` : k] = v;
  }
  return out;
}

const errorText = (err: unknown, fallback: string) => (err as { detail?: string } | null)?.detail ?? fallback;

export function NamingSettings() {
  const { libraryId } = useCurrentLibrary();
  const naming = useNaming(libraryId);
  if (!naming.data) return null;
  return <NamingForm key={libraryId} libraryId={libraryId} view={naming.data} />;
}

function NamingForm({ libraryId, view }: { libraryId: string | undefined; view: NamingView }) {
  const save = useSaveNaming(libraryId);
  const examples = useNamingExamples(libraryId);
  const [draft, setDraft] = useState<NamingRulesInput | null>(null);
  const [preview, setPreview] = useState<{ examples: NamingExample[]; problems: Record<string, string> } | null>(null);
  const [adding, setAdding] = useState('');
  const headingId = useId();
  const rules = draft ?? normalizeRules(view.rules);
  const problems = preview?.problems ?? viewProblems(view);
  const shown = preview?.examples ?? view.examples;

  // examples of the unsaved rules, 400 ms after the last keystroke; a late
  // answer to older rules is dropped
  const ask = examples.mutateAsync;
  const seq = useRef(0);
  useEffect(() => {
    if (!draft) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      ask(draft).then((r) => { if (n === seq.current) setPreview(r); }).catch(() => { /* the last examples stay */ });
    }, 400);
    return () => clearTimeout(t);
  }, [draft, ask]);

  const change = (next: Partial<NamingRulesInput>) => setDraft({ ...rules, ...next });
  const setSpecial = (i: number, folder: string) => change({ special: rules.special.map((s, j) => (j === i ? { ...s, folder } : s)) });
  const addLeaveAlone = (e: FormEvent) => {
    e.preventDefault();
    const v = adding.trim();
    if (!v) return;
    if (!rules.leaveAlone.includes(v)) change({ leaveAlone: [...rules.leaveAlone, v] });
    setAdding('');
  };

  const hasProblems = Object.keys(problems).length > 0;
  const canSave = (!!draft || !view.saved) && !hasProblems && !!rules.folder.trim() && !!rules.file.trim();
  const onSave = () => {
    save.mutate(rules, {
      onSuccess: () => { setDraft(null); setPreview(null); },
      onError: (err) => showToast({ message: errorText(err, 'Not saved'), tone: 'danger' }),
    });
  };

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>Naming</h2>
      {!view.saved && (
        <dl className={styles.values}>
          {view.detected?.found
            ? <><dt>Detected</dt><dd>{view.detected.matched.toLocaleString()} / {view.detected.sampled.toLocaleString()}</dd></>
            : <><dt>Rules</dt><dd>Default</dd></>}
        </dl>
      )}
      <TextField label="Folder" value={rules.folder} spellCheck={false} autoComplete="off" className={styles.mono} error={problems.folder} onChange={(e) => change({ folder: e.target.value })} />
      <TextField label="File" value={rules.file} spellCheck={false} autoComplete="off" className={styles.mono} error={problems.file} onChange={(e) => change({ file: e.target.value })} />
      <div className={styles.chips} aria-label="Variables">
        {VARIABLES.map((v) => <Chip key={v}><code>{v}</code></Chip>)}
      </div>

      {SPECIAL.map(({ label }, i) => (
        <TextField
          key={label}
          label={label}
          value={rules.special[i]?.folder ?? ''}
          placeholder="Off"
          spellCheck={false}
          autoComplete="off"
          className={styles.mono}
          error={problems[`special.${i}`]}
          onChange={(e) => setSpecial(i, e.target.value)}
        />
      ))}

      <h3 className={styles.subheading}>Leave alone</h3>
      {rules.leaveAlone.length > 0 && (
        <ul className={styles.list}>
          {rules.leaveAlone.map((p) => (
            <li key={p} className={styles.listRow}>
              <span className={styles.listValue} title={p}>{p}</span>
              <EmbossIconButton label={`Remove ${p}`} onClick={() => change({ leaveAlone: rules.leaveAlone.filter((x) => x !== p) })}><CloseIcon /></EmbossIconButton>
            </li>
          ))}
        </ul>
      )}
      <form className={styles.addRow} onSubmit={addLeaveAlone}>
        <Input aria-label="Folder to leave alone" value={adding} spellCheck={false} autoComplete="off" className={styles.mono} onChange={(e) => setAdding(e.target.value)} />
        <Button type="submit" variant="secondary" disabled={!adding.trim()}>Add</Button>
      </form>

      <h3 className={styles.subheading}>Examples</h3>
      {shown.length > 0
        ? (
          <ul className={styles.examples} aria-live="polite">
            {shown.slice(0, 3).map((x) => (
              <li key={`${x.albumId}:${x.from}`} className={styles.example}>
                <span className={styles.from}>{x.from}</span>
                <span className={styles.to}>{x.to}</span>
              </li>
            ))}
          </ul>
        )
        : <p className={styles.muted}>—</p>}

      <div className={styles.buttons}>
        <Button onClick={onSave} loading={save.isPending} disabled={!canSave}>Save</Button>
        {draft && <Button variant="quiet" onClick={() => { setDraft(null); setPreview(null); }} disabled={save.isPending}>Cancel</Button>}
      </div>
    </section>
  );
}
