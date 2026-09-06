/**
 * Reviews & listening on the album page (spec BRW-2 "Reviews" tab, REV-1..3):
 * the owner's rating / Markdown review with revisions, the listen log,
 * ingested external reviews with their licences, link-out chips, clippings.
 */
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ExternalReview, Listen, ListenFormat, ReviewsBundle } from '@liner/shared';
import type { Edition } from '../hooks/useLibrary';
import {
  useAddClipping, useAddListen, useDeleteClipping, useDeleteListen, useDeleteReview,
  useRefreshReviews, useReviewRevisions, useReviews, useSaveReview,
} from '../hooks/useReviews';
import { StarRating } from './StarRating';
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

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString() : '';
}
function fmtDateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '';
}
function todayLocalIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ReviewsSection({ libraryId, releaseGroupId, editions }: ReviewsSectionProps) {
  const { data, isLoading, error } = useReviews(libraryId, releaseGroupId);
  const refresh = useRefreshReviews(libraryId, releaseGroupId);

  if (isLoading) return <div className={styles.section}>Loading reviews…</div>;
  if (error || !data) return <div className={styles.section}>Reviews unavailable.</div>;

  return (
    <div className={styles.section}>
      <div className={styles.head}>
        <h2 className={styles.title}>Reviews &amp; listening</h2>
        <div className={styles.headMeta}>
          {data.gathering ? (
            <span className={styles.gathering}>Gathering reviews…</span>
          ) : (
            <span className={styles.muted}>external sources as of {fmtDateTime(data.fetchedAt)}</span>
          )}
          <button
            className={styles.linkButton}
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || data.gathering}
            title="Re-fetch external reviews and ratings now"
          >
            {refresh.isPending || refresh.isSuccess ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <OwnTake libraryId={libraryId} releaseGroupId={releaseGroupId} bundle={data} />
      <ListenLog libraryId={libraryId} releaseGroupId={releaseGroupId} listens={data.listens} editions={editions} />
      <ExternalReviews bundle={data} />
      <LinkChips bundle={data} />
      <Clippings libraryId={libraryId} releaseGroupId={releaseGroupId} bundle={data} />
    </div>
  );
}

/* ---------- Own rating + review (REV-3) ---------- */

function OwnTake({ libraryId, releaseGroupId, bundle }: { libraryId: string | undefined; releaseGroupId: string; bundle: ReviewsBundle }) {
  const own = bundle.own;
  const save = useSaveReview(libraryId, releaseGroupId);
  const remove = useDeleteReview(libraryId, releaseGroupId);
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const revisions = useReviewRevisions(libraryId, releaseGroupId, showHistory);

  const editing = draft !== null;
  const body = own?.bodyMd ?? '';

  return (
    <div className={styles.block}>
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle}>Your take</h3>
        <StarRating value={own?.rating ?? null} onChange={(rating) => save.mutate({ rating })} />
      </div>

      {!editing && (
        <>
          {body ? (
            <div className={styles.markdown}><ReactMarkdown>{body}</ReactMarkdown></div>
          ) : (
            <p className={styles.muted}>No review yet — rate above or write a few lines.</p>
          )}
          <div className={styles.row}>
            <button className={styles.linkButton} onClick={() => { setDraft(body); setPreview(false); }}>
              {body ? 'Edit review' : 'Write review'}
            </button>
            {own && (
              <>
                <span className={styles.muted}>
                  revision {own.currentRevision} · updated {fmtDate(own.updatedAt)}
                </span>
                <button className={styles.linkButton} onClick={() => setShowHistory((s) => !s)}>
                  {showHistory ? 'Hide history' : 'History'}
                </button>
                <button
                  className={styles.linkButton}
                  onClick={() => { if (window.confirm('Delete your rating, review and its revisions?')) remove.mutate(); }}
                  disabled={remove.isPending}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </>
      )}

      {editing && (
        <div className={styles.editor}>
          <div className={styles.row}>
            <button className={preview ? styles.linkButton : styles.linkButtonActive} onClick={() => setPreview(false)}>Write</button>
            <button className={preview ? styles.linkButtonActive : styles.linkButton} onClick={() => setPreview(true)}>Preview</button>
            <span className={styles.muted}>Markdown</span>
          </div>
          {preview ? (
            <div className={styles.markdown}>
              {draft.trim() ? <ReactMarkdown>{draft}</ReactMarkdown> : <p className={styles.muted}>Nothing to preview.</p>}
            </div>
          ) : (
            <textarea
              className={styles.textarea}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="What stays with you about this record?"
              rows={8}
              autoFocus
            />
          )}
          <div className={styles.row}>
            <button
              className={styles.primary}
              disabled={save.isPending || draft === body}
              onClick={() => save.mutate({ bodyMd: draft }, { onSuccess: () => setDraft(null) })}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button className={styles.linkButton} onClick={() => setDraft(null)}>Cancel</button>
            {save.isError && <span className={styles.error}>{(save.error as Error)?.message ?? 'Save failed'}</span>}
          </div>
        </div>
      )}

      {showHistory && revisions.data && (
        <ul className={styles.history}>
          {revisions.data.map((r) => (
            <li key={r.revision} className={styles.historyRow}>
              <span className={styles.muted}>#{r.revision} · {fmtDateTime(r.editedAt)}</span>
              <StarRating value={r.rating} size={14} />
              <span className={styles.historyBody}>{(r.bodyMd ?? '').slice(0, 140) || '—'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- Listen log (REV-3) ---------- */

function ListenLog({ libraryId, releaseGroupId, listens, editions }: {
  libraryId: string | undefined; releaseGroupId: string; listens: Listen[]; editions: Edition[] | undefined;
}) {
  const add = useAddListen(libraryId, releaseGroupId);
  const remove = useDeleteListen(releaseGroupId);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayLocalIso());
  const [format, setFormat] = useState<ListenFormat>('digital');
  const [releaseId, setReleaseId] = useState('');
  const [note, setNote] = useState('');

  const submit = () => {
    add.mutate(
      {
        listenedAt: new Date(`${date}T12:00:00`).toISOString(),
        format,
        releaseId: releaseId || null,
        note: note.trim() || null,
      },
      { onSuccess: () => { setNote(''); setOpen(false); } },
    );
  };

  return (
    <div className={styles.block}>
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle}>Listens {listens.length > 0 && <span className={styles.count}>{listens.length}</span>}</h3>
        <div className={styles.row}>
          <button className={styles.primary} onClick={() => add.mutate({ format })} disabled={add.isPending}>
            Listened today
          </button>
          <button className={styles.linkButton} onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Log a listen…'}</button>
        </div>
      </div>

      {open && (
        <div className={styles.listenForm}>
          <input type="date" className={styles.input} value={date} max={todayLocalIso()} onChange={(e) => setDate(e.target.value)} />
          <select className={styles.input} value={format} onChange={(e) => setFormat(e.target.value as ListenFormat)}>
            {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          {editions && editions.length > 0 && (
            <select className={styles.input} value={releaseId} onChange={(e) => setReleaseId(e.target.value)} title="Edition listened to">
              <option value="">Any edition</option>
              {editions.map((e) => (
                <option key={e.releaseId} value={e.releaseId}>
                  {[e.date, e.country, e.labels[0]?.name, e.media[0]?.format].filter(Boolean).join(' · ') || e.title}{e.owned ? ' (this copy)' : ''}
                </option>
              ))}
            </select>
          )}
          <input className={styles.input} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          <button className={styles.primary} onClick={submit} disabled={add.isPending}>Add</button>
        </div>
      )}
      {add.isError && <div className={styles.error}>{(add.error as { detail?: string })?.detail ?? 'Could not save the listen'}</div>}

      {listens.length > 0 && (
        <ul className={styles.list}>
          {listens.map((l) => (
            <li key={l.id} className={styles.listRow}>
              <span>{fmtDate(l.listenedAt)}</span>
              <span className={styles.chip}>{l.format ?? 'listened'}</span>
              {l.releaseTitle && <span className={styles.muted} title="Edition">{l.releaseTitle}</span>}
              {l.note && <span className={styles.note}>{l.note}</span>}
              <button className={styles.iconButton} title="Remove" onClick={() => remove.mutate(l.id)} disabled={remove.isPending}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- External reviews and ratings (REV-1) ---------- */

function ExternalReviews({ bundle }: { bundle: ReviewsBundle }) {
  const texts = bundle.external.filter((e) => e.source === 'wikipedia' || e.source === 'critiquebrainz');
  const ratings = bundle.external.filter((e) => e.source === 'musicbrainz' || e.source === 'discogs');
  const missing = (['wikipedia', 'critiquebrainz'] as const).filter((s) => !texts.some((t) => t.source === s));

  return (
    <div className={styles.block}>
      <h3 className={styles.blockTitle}>From the web</h3>

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
              {r.url && <a href={r.url} target="_blank" rel="noreferrer" className={styles.extLink}>↗</a>}
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

      {!bundle.gathering && missing.length > 0 && (
        <p className={styles.muted}>No reviews from {missing.map((s) => SOURCE_LABEL[s]).join(' or ')}.</p>
      )}
      {bundle.gathering && bundle.external.length === 0 && <p className={styles.muted}>Gathering reviews…</p>}
    </div>
  );
}

/* ---------- Link-outs (REV-2) ---------- */

function LinkChips({ bundle }: { bundle: ReviewsBundle }) {
  if (bundle.links.length === 0) return null;
  return (
    <div className={styles.block}>
      <h3 className={styles.blockTitle}>Elsewhere</h3>
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
    </div>
  );
}

/* ---------- Clippings (REV-2) ---------- */

function Clippings({ libraryId, releaseGroupId, bundle }: { libraryId: string | undefined; releaseGroupId: string; bundle: ReviewsBundle }) {
  const add = useAddClipping(libraryId, releaseGroupId);
  const remove = useDeleteClipping(releaseGroupId);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [score, setScore] = useState('');
  const [note, setNote] = useState('');

  const submit = () => {
    const scoreNum = score.trim() ? Number(score) : null;
    add.mutate(
      {
        url: url.trim() || null,
        sourceLabel: sourceLabel.trim() || null,
        scoreRaw: scoreNum != null && Number.isFinite(scoreNum) ? scoreNum : null,
        note: note.trim() || null,
      },
      { onSuccess: () => { setUrl(''); setSourceLabel(''); setScore(''); setNote(''); setOpen(false); } },
    );
  };

  return (
    <div className={styles.block}>
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle}>Clippings {bundle.clippings.length > 0 && <span className={styles.count}>{bundle.clippings.length}</span>}</h3>
        <button className={styles.linkButton} onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Add clipping…'}</button>
      </div>
      {open && (
        <div className={styles.listenForm}>
          <input className={styles.input} placeholder="URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          <input className={styles.input} placeholder="Source (e.g. Pitchfork)" value={sourceLabel} onChange={(e) => setSourceLabel(e.target.value)} />
          <input className={styles.input} placeholder="Score" value={score} onChange={(e) => setScore(e.target.value)} style={{ maxWidth: '6rem' }} />
          <input className={styles.input} placeholder="Quote or note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} />
          <button className={styles.primary} onClick={submit} disabled={add.isPending || !(url.trim() || note.trim())}>Add</button>
        </div>
      )}
      {add.isError && <div className={styles.error}>{(add.error as { detail?: string })?.detail ?? 'Could not save the clipping'}</div>}
      {bundle.clippings.length > 0 && (
        <ul className={styles.list}>
          {bundle.clippings.map((c) => (
            <li key={c.id} className={styles.listRow}>
              {c.sourceLabel && <span className={styles.chip}>{c.sourceLabel}</span>}
              {c.scoreRaw != null && <span className={styles.score}>{c.scoreRaw}</span>}
              {c.note && <span className={styles.note}>“{c.note}”</span>}
              {c.url && <a href={c.url} target="_blank" rel="noreferrer" className={styles.extLink}>↗</a>}
              <span className={styles.muted}>{fmtDate(c.createdAt)}</span>
              <button className={styles.iconButton} title="Remove" onClick={() => remove.mutate(c.id)} disabled={remove.isPending}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
