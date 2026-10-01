/**
 * Reviews & listening on the album page (spec BRW-2 "Reviews" tab, REV-1..3):
 * the owner's rating / Markdown review with revisions, the listen log,
 * ingested external reviews with their licences, link-out chips, clippings.
 *
 * Built for touch: every section is one row — a label, what is there now (or
 * what tapping does, when nothing is), and ONE obvious control (full width
 * on a phone, at the row's end on wider screens, always ≥44px). Adding a
 * listen with details or a clipping happens in one "Add" sheet with the two
 * kinds side by side, instead of forms scattered through the card.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ExternalReview, Listen, ListenFormat, ReviewsBundle } from '@liner/shared';
import type { Edition } from '../hooks/useLibrary';
import {
  useAddClipping, useAddListen, useDeleteClipping, useDeleteListen, useDeleteReview,
  useRefreshReviews, useReviewRevisions, useReviews, useSaveReview,
} from '../hooks/useReviews';
import { StarRating } from './StarRating';
import { Button, IconButton, SegmentedControl, confirmDialog, showToast } from './ui';
import styles from './ReviewsSection.module.css';

interface ReviewsSectionProps {
  libraryId: string | undefined;
  releaseGroupId: string;
  editions?: Edition[] | undefined;
}

const FORMATS: Array<{ value: ListenFormat; label: string }> = [
  { value: 'digital', label: 'Digital' },
  { value: 'vinyl', label: 'Vinyl' },
  { value: 'cd', label: 'CD' },
  { value: 'cassette', label: 'Cassette' },
  { value: 'stream', label: 'Stream' },
  { value: 'other', label: 'Other' },
];

const SOURCE_LABEL: Record<ExternalReview['source'], string> = {
  critiquebrainz: 'CritiqueBrainz',
  wikipedia: 'Wikipedia',
  musicbrainz: 'MusicBrainz',
  discogs: 'Discogs',
};

type AddKind = 'listen' | 'clipping';

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}
function fmtDateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '';
}
function todayLocalIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** One section of the card: label · current value · one control. */
function Row({ label, children, control, id }: { label: string; children: ReactNode; control?: ReactNode; id?: string }) {
  return (
    <div className={styles.row} id={id}>
      <h3 className={styles.rowLabel}>{label}</h3>
      <div className={styles.rowValue}>{children}</div>
      {control && <div className={styles.rowControl}>{control}</div>}
    </div>
  );
}

export function ReviewsSection({ libraryId, releaseGroupId, editions }: ReviewsSectionProps) {
  const { data, isLoading, error } = useReviews(libraryId, releaseGroupId);
  const [adding, setAdding] = useState<AddKind | null>(null);

  if (isLoading) return <div className={styles.section}><p className={styles.muted}>Loading reviews…</p></div>;
  if (error || !data) return <div className={styles.section}><p className={styles.muted}>Reviews are unavailable right now.</p></div>;

  return (
    <section className={styles.section} aria-labelledby="reviews-title">
      <h2 id="reviews-title" className={styles.title}>Reviews &amp; listening</h2>

      <RatingRow libraryId={libraryId} releaseGroupId={releaseGroupId} bundle={data} />
      <ReviewRow libraryId={libraryId} releaseGroupId={releaseGroupId} bundle={data} />
      <ListenRow libraryId={libraryId} releaseGroupId={releaseGroupId} listens={data.listens} onAdd={() => setAdding('listen')} />
      <ExternalRow libraryId={libraryId} releaseGroupId={releaseGroupId} bundle={data} />
      <LinkChips bundle={data} />
      <ClippingsRow releaseGroupId={releaseGroupId} bundle={data} onAdd={() => setAdding('clipping')} />

      {adding && (
        <AddSheet
          kind={adding}
          onKind={setAdding}
          onClose={() => setAdding(null)}
          libraryId={libraryId}
          releaseGroupId={releaseGroupId}
          editions={editions}
        />
      )}
    </section>
  );
}

/* ---------- Own rating (REV-3) ---------- */

function RatingRow({ libraryId, releaseGroupId, bundle }: { libraryId: string | undefined; releaseGroupId: string; bundle: ReviewsBundle }) {
  const save = useSaveReview(libraryId, releaseGroupId);
  const rating = bundle.own?.rating ?? null;
  return (
    <Row label="Your rating">
      <div className={styles.ratingLine}>
        <StarRating value={rating} size={34} onChange={(r) => save.mutate({ rating: r })} />
        {rating != null ? (<>
          <span className={styles.ratingHint}>{rating.toFixed(1)} of 5</span>
          <Button variant="quiet" size="sm" className={styles.clear} onClick={() => save.mutate({ rating: null })} disabled={save.isPending}>Clear</Button>
        </>) : (
          <span className={styles.ratingHint}>Tap a star; its left half gives a half star.</span>
        )}
      </div>
      {save.isError && <p className={styles.error}>{(save.error as { detail?: string })?.detail ?? 'The rating was not saved.'}</p>}
    </Row>
  );
}

/* ---------- Own review with revisions (REV-3) ---------- */

function ReviewRow({ libraryId, releaseGroupId, bundle }: { libraryId: string | undefined; releaseGroupId: string; bundle: ReviewsBundle }) {
  const own = bundle.own;
  const save = useSaveReview(libraryId, releaseGroupId);
  const remove = useDeleteReview(libraryId, releaseGroupId);
  const [draft, setDraft] = useState<string | null>(null);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [showHistory, setShowHistory] = useState(false);
  const revisions = useReviewRevisions(libraryId, releaseGroupId, showHistory);
  const body = own?.bodyMd ?? '';
  const editing = draft !== null;

  if (editing) {
    return (
      <Row label="Your review">
        <div className={styles.editor}>
          <SegmentedControl size="sm" label="Review editor" value={mode} onChange={setMode} options={[{ value: 'write', label: 'Write' }, { value: 'preview', label: 'Preview' }]} />
          {mode === 'preview' ? (
            <div className={styles.markdown}>
              {draft.trim() ? <ReactMarkdown>{draft}</ReactMarkdown> : <p className={styles.muted}>Nothing to preview yet.</p>}
            </div>
          ) : (
            <textarea
              className={styles.textarea}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="What stays with you about this record? (Markdown works.)"
              aria-label="Your review"
              rows={7}
              autoFocus
            />
          )}
          <div className={styles.formActions}>
            <Button variant="secondary" onClick={() => setDraft(null)}>Cancel</Button>
            <Button disabled={save.isPending || draft === body} onClick={() => save.mutate({ bodyMd: draft }, { onSuccess: () => setDraft(null) })}>
              {save.isPending ? 'Saving…' : 'Save review'}
            </Button>
          </div>
          {save.isError && <p className={styles.error}>{(save.error as Error)?.message ?? 'Save failed'}</p>}
        </div>
      </Row>
    );
  }

  return (
    <Row
      label="Your review"
      control={<Button variant="secondary" className={styles.control} onClick={() => { setDraft(body); setMode('write'); }}>{body ? 'Edit review' : 'Write a review'}</Button>}
    >
      {body ? (
        <>
          <div className={styles.markdown}><ReactMarkdown>{body}</ReactMarkdown></div>
          {own && (
            <div className={styles.meta}>
              <span>Revision {own.currentRevision} · updated {fmtDate(own.updatedAt)}</span>
              <Button variant="quiet" size="sm" onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory}>{showHistory ? 'Hide history' : 'History'}</Button>
              <Button
                variant="quiet-danger"
                size="sm"
                disabled={remove.isPending}
                onClick={async () => { if (await confirmDialog({ title: 'Delete your review?', message: 'Your rating, review and all its revisions are deleted. This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' })) remove.mutate(); }}
              >
                Delete
              </Button>
            </div>
          )}
          {showHistory && revisions.data && (
            <ul className={styles.list}>
              {revisions.data.map((r) => (
                <li key={r.revision} className={styles.listRow}>
                  <span className={styles.muted}>#{r.revision} · {fmtDateTime(r.editedAt)}</span>
                  <StarRating value={r.rating} size={14} />
                  <span className={styles.historyBody}>{(r.bodyMd ?? '').slice(0, 140) || '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className={styles.empty}>No review yet. Write a few lines about what stays with you; you can edit it any time and earlier versions are kept.</p>
      )}
    </Row>
  );
}

/* ---------- Listen log (REV-3) ---------- */

function ListenRow({ libraryId, releaseGroupId, listens, onAdd }: { libraryId: string | undefined; releaseGroupId: string; listens: Listen[]; onAdd: () => void }) {
  const add = useAddListen(libraryId, releaseGroupId);
  const remove = useDeleteListen(releaseGroupId);
  const [showAll, setShowAll] = useState(false);
  const today = todayLocalIso();
  const loggedToday = listens.some((l) => l.listenedAt && new Date(l.listenedAt).toDateString() === new Date().toDateString());
  const shown = showAll ? listens : listens.slice(0, 3);
  return (
    <Row
      label="Listens"
      control={(
        <Button
          variant="secondary"
          className={styles.control}
          disabled={add.isPending}
          onClick={() => add.mutate({ format: 'digital' }, { onSuccess: () => showToast({ message: 'Logged a listen for today', durationMs: 4000, action: { label: 'Add details', onClick: onAdd } }) })}
          title={`Log a listen on ${today}`}
        >
          {add.isPending ? 'Logging…' : loggedToday ? 'Log another today' : 'I listened today'}
        </Button>
      )}
    >
      {listens.length === 0 ? (
        <p className={styles.empty}>Not logged yet. “I listened today” logs one tap; <button type="button" className={styles.inlineLink} onClick={onAdd}>add one with a date, format or note</button>.</p>
      ) : (
        <>
          <p className={styles.summary}>
            {listens.length} {listens.length === 1 ? 'listen' : 'listens'} · last on {fmtDate(listens[0]?.listenedAt)}
            {' · '}<button type="button" className={styles.inlineLink} onClick={onAdd}>Add with details</button>
          </p>
          <ul className={styles.list}>
            {shown.map((l) => (
              <li key={l.id} className={styles.listRow}>
                <span className={styles.listDate}>{fmtDate(l.listenedAt)}</span>
                <span className={styles.chip}>{FORMATS.find((f) => f.value === l.format)?.label ?? l.format ?? 'Listened'}</span>
                {l.releaseTitle && <span className={styles.muted} title="Edition">{l.releaseTitle}</span>}
                {l.note && <span className={styles.note}>{l.note}</span>}
                <IconButton variant="quiet" size="sm" className={styles.removeButton} label={`Remove the listen on ${fmtDate(l.listenedAt)}`} onClick={() => remove.mutate(l.id)} disabled={remove.isPending}><span aria-hidden="true">✕</span></IconButton>
              </li>
            ))}
          </ul>
          {listens.length > 3 && (
            <Button variant="quiet" size="sm" onClick={() => setShowAll((s) => !s)} aria-expanded={showAll}>{showAll ? 'Show fewer' : `Show all ${listens.length}`}</Button>
          )}
        </>
      )}
      {add.isError && <p className={styles.error}>{(add.error as { detail?: string })?.detail ?? 'Could not save the listen'}</p>}
    </Row>
  );
}

/* ---------- External reviews and ratings (REV-1) ---------- */

function ExternalRow({ libraryId, releaseGroupId, bundle }: { libraryId: string | undefined; releaseGroupId: string; bundle: ReviewsBundle }) {
  const refresh = useRefreshReviews(libraryId, releaseGroupId);
  const texts = bundle.external.filter((e) => e.source === 'wikipedia' || e.source === 'critiquebrainz');
  const ratings = bundle.external.filter((e) => e.source === 'musicbrainz' || e.source === 'discogs');
  const missing = (['wikipedia', 'critiquebrainz'] as const).filter((s) => !texts.some((t) => t.source === s));
  const busy = refresh.isPending || bundle.gathering;

  return (
    <Row
      label="From the web"
      control={(
        <Button variant="secondary" className={styles.control} onClick={() => refresh.mutate()} disabled={busy} loading={busy}>
          {busy ? 'Gathering…' : bundle.fetchedAt ? 'Refresh reviews' : 'Gather reviews'}
        </Button>
      )}
    >
      {bundle.gathering && bundle.external.length === 0 && (
        <p className={styles.summary}>Looking on CritiqueBrainz, MusicBrainz, Wikipedia and Discogs…</p>
      )}
      {!bundle.gathering && !bundle.fetchedAt && bundle.external.length === 0 && (
        <p className={styles.empty}>Nothing gathered yet. Gather reviews looks this album up on CritiqueBrainz, MusicBrainz, Wikipedia and Discogs (one request each, only when you ask).</p>
      )}

      {ratings.length > 0 && (
        <div className={styles.ratingsRow}>
          {ratings.map((r) => (
            <span key={r.id} className={styles.ratingCard} title={r.license}>
              <strong>{SOURCE_LABEL[r.source]}</strong>
              <StarRating value={r.ratingRaw != null && r.ratingScale ? Math.round((r.ratingRaw / r.ratingScale) * 10) / 2 : null} size={14} />
              <span>{r.ratingRaw != null ? `${r.ratingRaw.toFixed(2)} / ${r.ratingScale ?? 5}` : 'no rating'}</span>
              {r.excerpt && <span className={styles.muted}>({r.excerpt})</span>}
              {r.source === 'discogs' && (
                <span className={styles.muted}>
                  {r.stale ? `as of ${fmtDateTime(r.fetchedAt)} · updating` : `as of ${fmtDateTime(r.fetchedAt)}`}
                  {' · '}
                  <a href="https://www.discogs.com" target="_blank" rel="noreferrer" className={styles.extLink}>Data provided by Discogs</a>
                </span>
              )}
              {r.url && <a href={r.url} target="_blank" rel="noreferrer" className={styles.extLink} aria-label={`${SOURCE_LABEL[r.source]} page`}>↗</a>}
            </span>
          ))}
        </div>
      )}

      {texts.map((r) => (
        <article key={r.id} className={styles.reviewCard}>
          <header className={styles.reviewHead}>
            <span className={styles.chip}>{SOURCE_LABEL[r.source]}</span>
            {r.title && <strong>{r.title}</strong>}
            {r.author && <span>{r.author}</span>}
            {r.publishedAt && <span className={styles.muted}>{fmtDate(r.publishedAt)}</span>}
            {r.ratingRaw != null && <StarRating value={r.ratingScale ? Math.round((r.ratingRaw / r.ratingScale) * 10) / 2 : null} size={14} />}
          </header>
          <div className={styles.markdown}>
            {r.source === 'wikipedia'
              ? (r.bodyText ?? '').split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)
              : <ReactMarkdown>{r.bodyText ?? r.excerpt ?? ''}</ReactMarkdown>}
          </div>
          <footer className={styles.reviewFoot}>
            <span>{r.license}</span>
            {r.url && (
              <a href={r.url} target="_blank" rel="noreferrer">
                {r.source === 'wikipedia' ? 'Read on Wikipedia ↗' : 'Read on CritiqueBrainz ↗'}
              </a>
            )}
          </footer>
        </article>
      ))}

      {bundle.fetchedAt && !bundle.gathering && (
        <p className={styles.muted}>
          {missing.length > 0 ? `No reviews from ${missing.map((s) => SOURCE_LABEL[s]).join(' or ')}. ` : ''}
          As of {fmtDateTime(bundle.fetchedAt)}.
        </p>
      )}
    </Row>
  );
}

/* ---------- Link-outs (REV-2) ---------- */

function LinkChips({ bundle }: { bundle: ReviewsBundle }) {
  if (bundle.links.length === 0) return null;
  return (
    <Row label="Elsewhere">
      <div className={styles.chips}>
        {bundle.links.map((l) => (
          <a
            key={`${l.source}-${l.url}`}
            className={l.discoveredVia === 'template' ? styles.chipSearch : styles.chipLink}
            href={l.url}
            target="_blank"
            rel="noreferrer"
            title={l.discoveredVia === 'template' ? `Search ${l.label}` : `${l.label} (via ${l.discoveredVia === 'wikidata' ? 'Wikidata' : 'MusicBrainz'})`}
          >
            {l.label} {l.discoveredVia === 'template' ? '🔍' : '↗'}
          </a>
        ))}
      </div>
    </Row>
  );
}

/* ---------- Clippings (REV-2) ---------- */

function ClippingsRow({ releaseGroupId, bundle, onAdd }: { releaseGroupId: string; bundle: ReviewsBundle; onAdd: () => void }) {
  const remove = useDeleteClipping(releaseGroupId);
  return (
    <Row label="Clippings" control={<Button variant="secondary" className={styles.control} onClick={onAdd}>Add a clipping</Button>}>
      {bundle.clippings.length === 0 ? (
        <p className={styles.empty}>Keep a quote, a score or a link from a review you read elsewhere (a magazine, a blog). Nothing saved yet.</p>
      ) : (
        <ul className={styles.list}>
          {bundle.clippings.map((c) => (
            <li key={c.id} className={styles.listRow}>
              {c.sourceLabel && <span className={styles.chip}>{c.sourceLabel}</span>}
              {c.scoreRaw != null && <span className={styles.score}>{c.scoreRaw}</span>}
              {c.note && <span className={styles.note}>“{c.note}”</span>}
              {c.url && <a href={c.url} target="_blank" rel="noreferrer" className={styles.extLink} aria-label="Open the clipping">↗</a>}
              <span className={styles.muted}>{fmtDate(c.createdAt)}</span>
              <IconButton variant="quiet" size="sm" className={styles.removeButton} label="Remove the clipping" onClick={() => remove.mutate(c.id)} disabled={remove.isPending}><span aria-hidden="true">✕</span></IconButton>
            </li>
          ))}
        </ul>
      )}
    </Row>
  );
}

/* ---------- The one "Add" sheet: a listen with details, or a clipping ---------- */

function AddSheet({ kind, onKind, onClose, libraryId, releaseGroupId, editions }: {
  kind: AddKind;
  onKind: (k: AddKind) => void;
  onClose: () => void;
  libraryId: string | undefined;
  releaseGroupId: string;
  editions: Edition[] | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const addListen = useAddListen(libraryId, releaseGroupId);
  const addClipping = useAddClipping(libraryId, releaseGroupId);
  const [date, setDate] = useState(todayLocalIso());
  const [format, setFormat] = useState<ListenFormat>('digital');
  const [releaseId, setReleaseId] = useState('');
  const [listenNote, setListenNote] = useState('');
  const [url, setUrl] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [score, setScore] = useState('');
  const [quote, setQuote] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement as HTMLElement | null;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const saveListen = () => addListen.mutate(
    { listenedAt: new Date(`${date}T12:00:00`).toISOString(), format, releaseId: releaseId || null, note: listenNote.trim() || null },
    { onSuccess: () => { showToast({ message: 'Listen logged', durationMs: 3000 }); onClose(); } },
  );
  const scoreNum = score.trim() ? Number(score) : null;
  const saveClipping = () => addClipping.mutate(
    { url: url.trim() || null, sourceLabel: sourceLabel.trim() || null, scoreRaw: scoreNum != null && Number.isFinite(scoreNum) ? scoreNum : null, note: quote.trim() || null },
    { onSuccess: () => { showToast({ message: 'Clipping saved', durationMs: 3000 }); onClose(); } },
  );

  return (
    <dialog
      ref={ref}
      className={styles.sheet}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <form className={styles.sheetPanel} onSubmit={(e) => { e.preventDefault(); if (kind === 'listen') saveListen(); else saveClipping(); }}>
        <div className={styles.sheetHead}>
          <h2 id={titleId} className={styles.sheetTitle}>Add to this album</h2>
          <IconButton variant="quiet" label="Close" onClick={onClose}><span aria-hidden="true">✕</span></IconButton>
        </div>
        <SegmentedControl label="What to add" value={kind} onChange={onKind} options={[{ value: 'listen', label: 'A listen' }, { value: 'clipping', label: 'A clipping' }]} />

        {kind === 'listen' ? (
          <div className={styles.fields}>
            <label className={styles.field}>
              <span>Date</span>
              <input type="date" value={date} max={todayLocalIso()} onChange={(e) => setDate(e.target.value)} required />
            </label>
            <label className={styles.field}>
              <span>Format</span>
              <select value={format} onChange={(e) => setFormat(e.target.value as ListenFormat)}>
                {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
            {editions && editions.length > 0 && (
              <label className={styles.field}>
                <span>Edition</span>
                <select value={releaseId} onChange={(e) => setReleaseId(e.target.value)}>
                  <option value="">Any edition</option>
                  {editions.map((e) => (
                    <option key={e.releaseId} value={e.releaseId}>
                      {[e.date, e.country, e.labels[0]?.name, e.media[0]?.format].filter(Boolean).join(' · ') || e.title}{e.owned ? ' (this copy)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className={styles.field}>
              <span>Note <em>(optional)</em></span>
              <input value={listenNote} onChange={(e) => setListenNote(e.target.value)} maxLength={500} placeholder="Where, with whom, how it sounded" />
            </label>
            {addListen.isError && <p className={styles.error}>{(addListen.error as { detail?: string })?.detail ?? 'Could not save the listen'}</p>}
          </div>
        ) : (
          <div className={styles.fields}>
            <label className={styles.field}>
              <span>Quote or note</span>
              <textarea value={quote} onChange={(e) => setQuote(e.target.value)} maxLength={4000} rows={3} placeholder="“A record that rewards patience.”" />
            </label>
            <label className={styles.field}>
              <span>Source <em>(optional)</em></span>
              <input value={sourceLabel} onChange={(e) => setSourceLabel(e.target.value)} placeholder="Pitchfork, The Wire, a friend" />
            </label>
            <div className={styles.fieldPair}>
              <label className={styles.field}>
                <span>Score <em>(optional)</em></span>
                <input inputMode="decimal" value={score} onChange={(e) => setScore(e.target.value)} placeholder="8.4" />
              </label>
              <label className={styles.field}>
                <span>Link <em>(optional)</em></span>
                <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
              </label>
            </div>
            {addClipping.isError && <p className={styles.error}>{(addClipping.error as { detail?: string })?.detail ?? 'Could not save the clipping'}</p>}
          </div>
        )}

        <div className={styles.formActions}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {kind === 'listen' ? (
            <Button type="submit" disabled={addListen.isPending || !date}>{addListen.isPending ? 'Saving…' : 'Log listen'}</Button>
          ) : (
            <Button type="submit" disabled={addClipping.isPending || !(url.trim() || quote.trim())}>{addClipping.isPending ? 'Saving…' : 'Save clipping'}</Button>
          )}
        </div>
      </form>
    </dialog>
  );
}
