/**
 * The Reviews tab's ledger: Critic scores and From the web as one kind of
 * row, the track list's rhythm. Each row is the source's name (what it is
 * under it), the score right-aligned in tabular figures, and a fixed 44px
 * column for the link out, so the arrow never wraps onto a line of its own.
 * Critic scores are grouped by where they came from: the source's aggregate
 * first, its outlets under it. A written review is a row too; its excerpt
 * shows two lines and opens in place.
 */
import { useId, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { CriticScore, ExternalReview } from '@tagave/shared';
import { StarRating } from './StarRating';
import { ChevronDownIcon } from './ui';
import { shortDate } from '../utils/time';
import s from './ReviewsLedger.module.css';

const SOURCE_LABEL: Record<ExternalReview['source'], string> = {
  critiquebrainz: 'CritiqueBrainz',
  wikipedia: 'Wikipedia',
  musicbrainz: 'MusicBrainz',
  discogs: 'Discogs',
};

/** "9.1 / 10", split so the scale reads quieter than the number. */
function Score10({ score, raw }: { score: number | null; raw?: string | null | undefined }) {
  if (score === null) return <span>{raw ?? 'no score'}</span>;
  return <span><span data-num>{score.toFixed(1)}</span><span data-scale> / 10</span></span>;
}

/** A source that is one review (CritiqueBrainz): its aggregate links to that review. */
function aggregateLink(v: CriticScore): string | null {
  const own = v.reviews.filter((r) => r.via === null && r.outlet === v.source.label && r.url);
  return own.length === 1 ? own[0]!.url : null;
}

/** Stars out of five for an external rating. */
function starsOf(raw: number | null, scale: number | null): number | null {
  return raw != null && scale ? Math.round((raw / scale) * 10) / 2 : null;
}

/** A thin arrow up and to the right: opens elsewhere. Same stroke as the ui icons. */
export function ArrowOutIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M8 16 16 8M9.5 8H16v6.5" />
    </svg>
  );
}

function Line({ name, sub, value, href, linkLabel, head, title }: {
  name: ReactNode; sub?: ReactNode; value?: ReactNode; href?: string | null; linkLabel?: string; head?: boolean; title?: string | undefined;
}) {
  return (
    <div className={[s.line, head ? s.head : ''].join(' ')} title={title}>
      <div className={s.nameCell}>
        <span className={s.name}>{name}</span>
        {sub}
      </div>
      <div className={s.value}>{value}</div>
      <GoCell href={href} label={linkLabel} />
    </div>
  );
}

function GoCell({ href, label }: { href?: string | null | undefined; label?: string | undefined }) {
  return (
    <div className={s.goCell}>
      {href && <a className={s.go} href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title={label}><ArrowOutIcon /></a>}
    </div>
  );
}

/* ---------- Critic scores ---------- */

export function CriticLedger({ values }: { values: CriticScore[] }) {
  return (
    <ul className={s.ledger}>
      {values.map((v) => {
        // the source's own review (CritiqueBrainz) is its aggregate, not an outlet under it
        const outlets = [
          ...v.reviews.filter((r) => !(r.via === null && r.outlet === v.source.label)).map((r) => ({ label: r.label, outlet: r.outlet, score: r.score, raw: r.scoreRaw, url: r.url })),
          ...v.criticRatings.map((r) => ({ label: r.label, outlet: r.outlet, score: r.score, raw: r.scoreRaw as string | null, url: null as string | null })),
        ];
        const agg = v.aggregate;
        const sub = [agg?.tier, agg && agg.reviewCount > 1 ? `${agg.reviewCount} reviews` : null].filter(Boolean).join(' · ');
        return (
          <li key={`${v.source.module}:${v.source.ref ?? ''}`} className={s.group}>
            <Line
              head
              name={v.source.label}
              sub={sub ? <span className={s.sub}>{sub}</span> : null}
              value={agg && agg.score !== null ? <Score10 score={agg.score} /> : null}
              href={aggregateLink(v)}
              linkLabel={`${v.source.label}: the review`}
            />
            {outlets.length > 0 && (
              <ul className={s.outlets}>
                {outlets.map((o, i) => (
                  <li key={i} className={s.outlet}>
                    <Line name={o.outlet} value={<Score10 score={o.score} raw={o.raw} />} href={o.url} linkLabel={`${o.label}: the review`} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ---------- From the web ---------- */

export function WebLedger({ external }: { external: ExternalReview[] }) {
  const ratings = external.filter((e) => e.source === 'musicbrainz' || e.source === 'discogs');
  const texts = external.filter((e) => e.source === 'wikipedia' || e.source === 'critiquebrainz');
  return (
    <ul className={s.ledger}>
      {ratings.map((r) => (
        <li key={r.id} className={s.item}>
          <Line
            title={r.license}
            name={SOURCE_LABEL[r.source]}
            sub={<>
              {r.excerpt && <span className={s.sub}>({r.excerpt})</span>}
              {r.source === 'discogs' && (
                <span className={s.sub}>
                  {r.stale ? `as of ${shortDate(r.fetchedAt)} · updating` : `as of ${shortDate(r.fetchedAt)}`}
                  {' · '}
                  <a href="https://www.discogs.com" target="_blank" rel="noopener noreferrer" className={s.attribution}>Data provided by Discogs</a>
                </span>
              )}
            </>}
            value={<span className={s.rated}>
              <span className={s.ratedStars}><StarRating value={starsOf(r.ratingRaw, r.ratingScale)} size={13} /></span>
              <span>{r.ratingRaw != null ? <><span data-num>{r.ratingRaw.toFixed(2)}</span><span data-scale> / {r.ratingScale ?? 5}</span></> : 'no rating'}</span>
            </span>}
            href={r.url}
            linkLabel={`${SOURCE_LABEL[r.source]} page`}
          />
        </li>
      ))}
      {texts.map((r) => <TextReviewLine key={r.id} r={r} />)}
    </ul>
  );
}

/**
 * Markdown as plain text, for the collapsed two-line preview: no `**`, no
 * `[text](url)`, no heading or quote marks. The opened excerpt renders the
 * Markdown itself.
 */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function TextReviewLine({ r }: { r: ExternalReview }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <TextReviewView r={r} open={open} onToggle={() => setOpen((o) => !o)} id={id} />;
}

/** One written review's row; `open` shows the whole excerpt and its licence. */
export function TextReviewView({ r, open, onToggle, id }: { r: ExternalReview; open: boolean; onToggle: () => void; id: string }) {
  const paragraphs = (r.bodyText ?? r.excerpt ?? '').split(/\n{2,}/);
  const sub = [r.title, r.author, r.publishedAt ? shortDate(r.publishedAt, { time: false }) : null].filter(Boolean);
  return (
    <li className={s.item}>
      <div className={s.line}>
        <button type="button" className={s.disclose} aria-expanded={open} aria-controls={id} onClick={onToggle}>
          <span className={s.name}>
            {SOURCE_LABEL[r.source]}
            <span className={[s.chevron, open ? s.chevronOpen : ''].join(' ')}><ChevronDownIcon /></span>
          </span>
          {sub.length > 0 && (
            <span className={s.sub}>
              {sub.map((t, i) => <span key={i} className={i === 0 && r.title ? s.subTitle : undefined}>{i > 0 && ' · '}{t}</span>)}
            </span>
          )}
        </button>
        <div className={s.value}>
          {r.ratingRaw != null && <StarRating value={starsOf(r.ratingRaw, r.ratingScale)} size={13} />}
        </div>
        <GoCell href={r.url} label={r.source === 'wikipedia' ? 'Read on Wikipedia' : 'Read on CritiqueBrainz'} />
      </div>
      <div id={id} className={s.excerpt}>
        {open ? (
          <>
            <div className={s.body}>
              {r.source === 'wikipedia' ? paragraphs.map((p, i) => <p key={i}>{p}</p>) : <ReactMarkdown>{r.bodyText ?? r.excerpt ?? ''}</ReactMarkdown>}
            </div>
            <p className={s.license}>{r.license}</p>
          </>
        ) : (
          <p className={s.clamp}>{r.source === 'wikipedia' ? paragraphs[0] : plainText(r.excerpt ?? paragraphs[0] ?? '')}</p>
        )}
      </div>
    </li>
  );
}
