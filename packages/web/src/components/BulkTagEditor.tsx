/**
 * Set album-level tags for every file in a selection in one step: an album,
 * several albums picked in the grid, or everything in a folder. The owner
 * ticks the fields to change and types (or accepts) the values; the result is
 * a tag plan with the manual preset, which opens on its own page with the
 * per-file preview. Nothing is written before Apply there, every write is
 * journalled, and Revert undoes it.
 *
 * Per-track artists stay as they are unless the owner explicitly ticks
 * "Track artist": on a compilation they are the one thing that is right.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { ManualTagValues } from '@liner/shared';
import { Button, Banner } from './ui';
import { Input } from './ui/FormControl';
import { useCreateTagPlan } from '../hooks/usePlanWizard';
import { useTagEditSuggestion, type EditScope, type TagEditSuggestion, type ValueCount } from '../hooks/useCompilations';
import styles from './BulkTagEditor.module.css';

export interface EditScopeOption {
  key: string;
  label: string;
  scope: EditScope;
}

type TextField = 'albumartist' | 'album' | 'date' | 'genre' | 'artist';
type FieldState = { on: boolean; value: string };
type Form = Record<TextField, FieldState> & { compilation: 'leave' | '1' | '0' };

const LABEL: Record<TextField, string> = {
  albumartist: 'Album artist',
  album: 'Album title',
  date: 'Year or date',
  genre: 'Genre',
  artist: 'Track artist',
};

/** true when every file already carries exactly this value */
const allAlready = (current: ValueCount[], files: number, value: string | undefined) =>
  value !== undefined && current.length === 1 && current[0]!.value === value && current[0]!.files === files;

/**
 * The selection reads as one album: one album (a merged one included), or
 * files that already agree on the title. Only then does the editor start
 * with the album-level suggestion ticked; several unrelated albums (a grid
 * selection to set a genre, a whole discography folder) start with nothing
 * ticked, and the suggestion is one click away instead.
 */
export function selectionIsOneAlbum(s: TagEditSuggestion): boolean {
  if (typeof s.confident === 'boolean') return s.confident;
  return s.albums <= 1 || (s.distinct?.album ?? s.current.album.length) <= 1;
}

export function formFromSuggestion(s: TagEditSuggestion, opts: { applySuggestion?: boolean } = {}): Form {
  const sug = s.suggested;
  const tick = opts.applySuggestion ?? selectionIsOneAlbum(s);
  const genre = sug.genre?.join('; ') ?? '';
  const field = (name: 'albumartist' | 'album' | 'date', current: ValueCount[]): FieldState => ({
    value: sug[name] ?? current[0]?.value ?? '',
    on: tick && sug[name] !== undefined && !allAlready(current, s.files, sug[name]),
  });
  return {
    albumartist: field('albumartist', s.current.albumartist),
    album: field('album', s.current.album),
    date: field('date', s.current.date),
    genre: { value: genre, on: false },
    artist: { value: s.current.artist[0]?.value ?? '', on: false },
    compilation: tick && sug.compilation === '1' && s.current.compilation.yes < s.files ? '1' : 'leave',
  };
}

/** "album artist Various Artists, album “Hotel Costes Vol. 11”, compilation" */
function suggestionSummary(s: TagEditSuggestion): string | null {
  const parts: string[] = [];
  if (s.suggested.albumartist) parts.push(`album artist ${s.suggested.albumartist}`);
  if (s.suggested.album) parts.push(`album “${s.suggested.album}”`);
  if (s.suggested.date) parts.push(`year ${s.suggested.date}`);
  if (s.suggested.compilation === '1') parts.push('compilation');
  return parts.length ? parts.join(', ') : null;
}

/** The manual values a form asks for; throws a readable message for a bad date. */
export function valuesFromForm(form: Form): ManualTagValues {
  const out: ManualTagValues = {};
  const text = (f: 'albumartist' | 'album' | 'artist') => {
    if (form[f].on && form[f].value.trim()) out[f] = form[f].value.trim();
  };
  text('albumartist');
  text('album');
  text('artist');
  if (form.date.on && form.date.value.trim()) {
    const d = form.date.value.trim();
    if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(d)) throw new Error('Year or date: use 2008, 2008-05 or 2008-05-17.');
    out.date = d;
  }
  if (form.genre.on) {
    const g = form.genre.value.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
    if (g.length) out.genre = [...new Set(g)];
  }
  if (form.compilation !== 'leave') out.compilation = form.compilation;
  return out;
}

function Current({ values, files, distinct }: { values: ValueCount[]; files: number; distinct?: number }) {
  if (values.length === 0) return <span className={styles.now}>Now: empty on every file</span>;
  const shown = values.slice(0, 3).map((v) => (values.length === 1 && v.files === files ? v.value : `${v.value} (${v.files})`));
  const total = Math.max(distinct ?? values.length, values.length);
  return (
    <span className={styles.now} title={values.map((v) => `${v.value} · ${v.files}`).join('\n')}>
      Now: {shown.join(', ')}{total > 3 ? ` and ${total - 3} more` : ''}
    </span>
  );
}

export function BulkTagEditor({
  libraryId,
  scopes,
  title,
  onClose,
}: {
  libraryId: string;
  /** what the edit can cover; the first is chosen */
  scopes: EditScopeOption[];
  title?: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [scopeKey, setScopeKey] = useState(scopes[0]?.key ?? '');
  const chosen = scopes.find((s) => s.key === scopeKey) ?? scopes[0];
  const suggestion = useTagEditSuggestion(libraryId, chosen?.scope ?? null);
  const createPlan = useCreateTagPlan(libraryId);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    return () => { if (d?.open) d.close(); };
  }, []);

  // A new selection starts from its own suggestion.
  useEffect(() => {
    if (suggestion.data) setForm(formFromSuggestion(suggestion.data));
  }, [suggestion.data]);

  const s = suggestion.data;
  const oneAlbum = s ? selectionIsOneAlbum(s) : true;
  const offer = s && !oneAlbum ? suggestionSummary(s) : null;
  const values = useMemo(() => {
    if (!form) return null;
    try { return valuesFromForm(form); } catch { return null; }
  }, [form]);
  const changing = values ? Object.keys(values) : [];

  const set = (f: TextField, patch: Partial<FieldState>) =>
    setForm((prev) => (prev ? { ...prev, [f]: { ...prev[f], ...patch } } : prev));

  const submit = async () => {
    if (!form || !s || !chosen) return;
    setError(null);
    let v: ManualTagValues;
    try { v = valuesFromForm(form); } catch (e) { setError((e as Error).message); return; }
    if (Object.keys(v).length === 0) { setError('Tick at least one field to change.'); return; }
    try {
      // A folder edit covers exactly the files in the folder, so the plan
      // keeps the folder as its scope; a selection of albums keeps the ids.
      const plan = await createPlan.mutateAsync({
        name: `Set values: ${v.album ?? s.current.album[0]?.value ?? chosen.label}`,
        scope: chosen.scope.type === 'folder' ? chosen.scope : { type: 'albumIds', albumIds: s.albumIds },
        policy: { preset: 'manual', id3Version: '2.4', multiValueSeparator: '; ', values: v },
      });
      onClose();
      void navigate({ to: '/plans/$planId', params: { planId: plan.id } });
    } catch (e) {
      setError((e as { detail?: string; message?: string })?.detail ?? (e as Error).message ?? 'The plan could not be created.');
    }
  };

  const row = (f: TextField, extra?: ReactNode, current?: ValueCount[], hint?: string) => {
    if (!form || !s) return null;
    const id = `bte-${f}`;
    return (
      <div className={`${styles.row} ${form[f].on ? styles.rowOn : ''}`}>
        <label className={styles.check}>
          <input type="checkbox" checked={form[f].on} onChange={(e) => set(f, { on: e.target.checked })} aria-controls={id} />
          <span>{LABEL[f]}</span>
        </label>
        <div className={styles.fieldBody}>
          <Input
            id={id}
            aria-label={LABEL[f]}
            value={form[f].value}
            disabled={!form[f].on}
            placeholder={f === 'genre' ? 'Lounge; Downtempo' : f === 'date' ? '2008' : ''}
            onChange={(e) => set(f, { value: e.target.value })}
          />
          {current && <Current values={current} files={s.files} {...(s.distinct ? { distinct: s.distinct[f] } : {})} />}
          {hint && <span className={styles.hint}>{hint}</span>}
          {extra}
        </div>
      </div>
    );
  };

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby={headingId} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className={styles.head}>
        <h2 id={headingId} className={styles.title}>{title ?? 'Set album values'}</h2>
        <p className={styles.lede}>
          {s ? `${s.files.toLocaleString()} file${s.files === 1 ? '' : 's'} in ${s.albums.toLocaleString()} album${s.albums === 1 ? '' : 's'}. ` : ''}
          You will see every change before anything is written.
        </p>
      </div>

      {scopes.length > 1 && (
        <fieldset className={styles.scopes}>
          <legend className={styles.legend}>Apply to</legend>
          {scopes.map((o) => (
            <label key={o.key} className={styles.scope}>
              <input type="radio" name="bte-scope" checked={o.key === scopeKey} onChange={() => setScopeKey(o.key)} />
              <span>{o.label}</span>
            </label>
          ))}
        </fieldset>
      )}

      <div className={styles.body}>
        {suggestion.isLoading && <p className={styles.muted}>Reading the tags…</p>}
        {suggestion.isError && (
          <Banner tone="danger">{(suggestion.error as { detail?: string } | null)?.detail ?? 'The tags could not be read.'}</Banner>
        )}
        {s && form && (
          <>
            {s.notes.length > 0 && (
              <ul className={styles.notes}>
                {s.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            )}
            {offer && (
              <div className={styles.offer}>
                <span>Suggested if these are one album: {offer}.</span>
                <Button variant="secondary" size="sm" onClick={() => setForm(formFromSuggestion(s, { applySuggestion: true }))}>
                  Use the suggestion
                </Button>
              </div>
            )}
            {row('albumartist', s.albumArtistOptions.length > 0 && (
              <span className={styles.options}>
                {s.albumArtistOptions.map((o) => (
                  <button key={o} type="button" className={styles.option} onClick={() => set('albumartist', { value: o, on: true })}>{o}</button>
                ))}
              </span>
            ), s.current.albumartist)}
            {row('album', undefined, s.current.album)}
            {row('date', undefined, s.current.date)}
            <div className={`${styles.row} ${form.compilation !== 'leave' ? styles.rowOn : ''}`}>
              <span className={styles.checkLabel}>Compilation</span>
              <div className={styles.fieldBody}>
                <div className={styles.segmented} role="radiogroup" aria-label="Compilation flag">
                  {([['leave', 'Leave as is'], ['1', 'Yes, a compilation'], ['0', 'Not a compilation']] as const).map(([v, label]) => (
                    <label key={v} className={`${styles.segment} ${form.compilation === v ? styles.segmentOn : ''}`}>
                      <input type="radio" name="bte-compilation" value={v} checked={form.compilation === v} onChange={() => setForm({ ...form, compilation: v })} />
                      {label}
                    </label>
                  ))}
                </div>
                <span className={styles.now}>Now: {s.current.compilation.yes === 0 ? 'no file is flagged' : `${s.current.compilation.yes} of ${s.files} flagged`}</span>
              </div>
            </div>
            {row('genre', undefined, s.current.genre, 'Separate several with ; — replaces the genre on every file.')}
            <div className={styles.divider} />
            {row('artist', undefined, s.current.artist,
              s.trackArtistsDiffer ? 'The tracks have different artists: leave this off for a compilation.' : 'Sets the same artist on every track.')}
          </>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>

      <div className={styles.foot}>
        <span className={styles.summary}>
          {changing.length === 0 ? 'Nothing ticked yet' : `Changes: ${changing.map((f) => (f === 'compilation' ? 'Compilation' : LABEL[f as TextField])).join(', ')}`}
        </span>
        <span className={styles.actions}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={createPlan.isPending} disabled={!s || changing.length === 0}>
            {createPlan.isPending ? 'Preparing…' : 'Preview changes'}
          </Button>
        </span>
      </div>
    </dialog>
  );
}
