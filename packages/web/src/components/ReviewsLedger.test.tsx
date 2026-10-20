/**
 * The Reviews ledger (Critic scores and From the web): one row per source,
 * the score flush right, the link in its own column; written reviews as rows
 * whose excerpt opens in place.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CriticScore, ExternalReview } from '@tagave/shared';
import { CriticLedger, TextReviewView, WebLedger, plainText } from './ReviewsLedger';
import { ClippingsRow } from './ReviewsSection';

const ext = (over: Partial<ExternalReview> & Pick<ExternalReview, 'id' | 'source'>): ExternalReview => ({
  sourceId: null, url: null, author: null, title: null, bodyText: null, excerpt: null, ratingRaw: null, ratingScale: null, ratingNormalized: null,
  license: 'CC0', language: null, publishedAt: null, fetchedAt: '2026-10-12T09:30:00.000Z', stale: false, ...over,
});

const text = (html: string) => html.replace(/<[^>]+>/g, '');
/** The <a> tag whose aria-label is `label`. */
const linkTag = (html: string, label: string) => html.match(new RegExp(`<a[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';

const critique = ext({
  id: 'cb', source: 'critiquebrainz', url: 'https://critiquebrainz.org/review/1', author: 'moondog', title: 'Motorik before it had a name',
  bodyText: 'The **template** for half of what came after, says [Dinger](https://example.org/dinger).\n\n> Second paragraph.', ratingRaw: 4, ratingScale: 5,
  license: 'CC BY-SA 3.0', publishedAt: '2019-04-03T00:00:00.000Z',
});
const wikipedia = ext({
  id: 'wp', source: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Neu!_(album)', license: 'CC BY-SA 4.0',
  bodyText: 'Neu! is the debut studio album by the German krautrock band Neu!.\n\nIt was recorded in December 1971.',
});

describe('WebLedger', () => {
  it('renders nothing for an empty bundle', () => {
    expect(text(renderToStaticMarkup(<WebLedger external={[]} />))).toBe('');
    expect(text(renderToStaticMarkup(<CriticLedger values={[]} />))).toBe('');
    expect(renderToStaticMarkup(<CriticLedger values={[]} />)).not.toContain('<li');
  });

  it('MusicBrainz and Discogs: the rating flush right, the count in parentheses, Discogs’ attribution, a page link each', () => {
    const html = renderToStaticMarkup(<WebLedger external={[
      ext({ id: 'mb', source: 'musicbrainz', url: 'https://musicbrainz.org/release-group/1', excerpt: '12 votes', ratingRaw: 4.25, ratingScale: 5 }),
      ext({ id: 'dg', source: 'discogs', url: 'https://www.discogs.com/master/1', excerpt: '311 ratings', ratingRaw: 4.31, ratingScale: 5, license: 'Discogs data' }),
    ]} />);
    const t = text(html);
    expect(t).toContain('MusicBrainz(12 votes)');
    expect(t).toContain('4.25 / 5');
    expect(t).toContain('Discogs(311 ratings)');
    expect(t).toMatch(/as of [^·]+ · Data provided by Discogs/);
    expect(t).toContain('4.31 / 5');
    expect(linkTag(html, 'MusicBrainz page')).toContain('href="https://musicbrainz.org/release-group/1"');
    expect(linkTag(html, 'Discogs page')).toContain('href="https://www.discogs.com/master/1"');
    expect(html).toMatch(/<a href="https:\/\/www\.discogs\.com" target="_blank" rel="noopener noreferrer"[^>]*>Data provided by Discogs<\/a>/);
    // a stale Discogs rating says it is updating
    expect(text(renderToStaticMarkup(<WebLedger external={[ext({ id: 'dg', source: 'discogs', ratingRaw: 4, ratingScale: 5, stale: true })]} />))).toContain('· updating');
    // no rating yet
    expect(text(renderToStaticMarkup(<WebLedger external={[ext({ id: 'mb', source: 'musicbrainz' })]} />))).toContain('no rating');
  });

  it('written reviews: the link is the trailing arrow, named "Read on …"', () => {
    const html = renderToStaticMarkup(<WebLedger external={[critique, wikipedia]} />);
    expect(linkTag(html, 'Read on CritiqueBrainz')).toContain('href="https://critiquebrainz.org/review/1"');
    expect(linkTag(html, 'Read on Wikipedia')).toContain('href="https://en.wikipedia.org/wiki/Neu!_(album)"');
    expect(linkTag(html, 'Read on Wikipedia')).toContain('rel="noopener noreferrer"');
    // title · author · short date under the source's name
    expect(text(html)).toContain('Motorik before it had a name · moondog · 3 Apr 2019');
  });
});

describe('a written review’s disclosure', () => {
  const view = (r: ExternalReview, open: boolean, onToggle = () => {}) => renderToStaticMarkup(<TextReviewView r={r} open={open} onToggle={onToggle} id="ex-1" />);

  it('closed: aria-expanded false, controls the excerpt, a two-line preview in plain text', () => {
    const html = view(critique, false);
    expect(html).toMatch(/<button type="button"[^>]*aria-expanded="false" aria-controls="ex-1"/);
    expect(html).toContain('id="ex-1"');
    expect(text(html)).toContain('The template for half of what came after, says Dinger.');
    expect(html).not.toContain('**');
    expect(html).not.toContain('](');
    expect(html).not.toContain('CC BY-SA 3.0');
  });

  it('open: aria-expanded true, the excerpt rendered as Markdown with its licence', () => {
    const html = view(critique, true);
    expect(html).toMatch(/aria-expanded="true" aria-controls="ex-1"/);
    expect(html).toContain('<strong>template</strong>');
    expect(html).toContain('href="https://example.org/dinger"');
    expect(text(html)).toContain('CC BY-SA 3.0');
    // Wikipedia's text is plain paragraphs, both of them
    const wp = view(wikipedia, true);
    expect(wp.match(/<p>/g)?.length).toBe(2);
    expect(text(view(wikipedia, false))).toContain('Neu! is the debut studio album');
    expect(text(view(wikipedia, false))).not.toContain('It was recorded');
  });

  it('the button toggles', () => {
    const onToggle = vi.fn();
    const button = findButton(TextReviewView({ r: critique, open: false, onToggle, id: 'ex-1' }));
    expect(button?.props['aria-controls']).toBe('ex-1');
    (button?.props.onClick as () => void)();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe('plainText', () => {
  it('strips Markdown to what a reader sees', () => {
    expect(plainText('# Heading\n\n**Bold** and _em_ and `code` and ~~gone~~ [link](https://x.org) ![alt](i.png)')).toBe('Heading Bold and em and code and gone link alt');
    expect(plainText('> quoted\n- item\n1. first')).toBe('quoted item first');
    expect(plainText('snake_case_name stays')).toBe('snake_case_name stays');
  });
});

describe('CriticLedger', () => {
  const gatherer: CriticScore = {
    source: { module: 'mc', ref: 'l1', label: 'review-gatherer' }, aggregate: { score: 8.7, tier: 'A', reviewCount: 3 },
    reviews: [
      { label: 'Pitchfork (via review-gatherer)', outlet: 'Pitchfork', via: 'review-gatherer', score: 9.1, scoreRaw: '9.1', url: 'https://pitchfork.com/r/1', publishedAt: null },
      { label: 'The Quietus (via review-gatherer)', outlet: 'The Quietus', via: 'review-gatherer', score: null, scoreRaw: 'unscored', url: 'https://thequietus.com/1', publishedAt: null },
    ],
    criticRatings: [{ label: 'Metacritic (via review-gatherer)', outlet: 'Metacritic', via: 'review-gatherer', score: 8.6, scoreRaw: '86' }],
    updatedAt: null,
  };

  it('the review-gatherer group: the app heads it with its aggregate, its outlets under it, in order', () => {
    const html = renderToStaticMarkup(<CriticLedger values={[gatherer]} />);
    const t = text(html);
    expect(t).toBe('review-gathererA · 3 reviews8.7 / 10Pitchfork9.1 / 10The Quietusunscored' + 'Metacritic8.6 / 10');
    expect(html.match(/<li/g)).toHaveLength(4);
    // the app has no page of its own: its head row has an empty link column
    expect(html).not.toContain('aria-label="review-gatherer: the review"');
    expect(linkTag(html, 'The Quietus \\(via review-gatherer\\): the review')).toContain('href="https://thequietus.com/1"');
    // a critic rating has no link
    expect(html).not.toContain('aria-label="Metacritic (via review-gatherer): the review"');
  });

  it('a long outlet name wraps in its own column; the score and the arrow stay whole beside it', () => {
    const long = 'The Extremely Long Name of a Quarterly Review of Experimental and Electronic Music';
    const html = renderToStaticMarkup(<CriticLedger values={[{ ...gatherer, reviews: [{ ...gatherer.reviews[0]!, outlet: long, label: `${long} (via review-gatherer)` }], criticRatings: [] }]} />);
    const row = html.slice(html.indexOf(long) - 400, html.indexOf('</li>', html.indexOf(long)));
    // name, value and link column are three siblings of one line: the arrow cannot fall under the name
    expect(row).toMatch(new RegExp(`<span class="[^"]*">${long}</span></div><div class="[^"]*"><span><span data-num="[^"]*">9.1</span><span data-scale="[^"]*"> / 10</span></span></div><div class="[^"]*"><a [^>]*aria-label="${long} \\(via review-gatherer\\): the review"`));
    // and the CSS keeps it so: the name column shrinks and wraps, the score never wraps, the link column is a fixed 44px
    const css = readFileSync(new URL('./ReviewsLedger.module.css', import.meta.url), 'utf8');
    const rule = (sel: string) => css.match(new RegExp(`(^|\\n)${sel.replace('.', '\\.')} \\{([^}]*)\\}`))?.[2] ?? '';
    expect(rule('.line')).toMatch(/grid-template-columns: minmax\(0, 1fr\) auto 44px/);
    expect(rule('.name')).toMatch(/overflow-wrap: anywhere/);
    expect(rule('.value')).toMatch(/white-space: nowrap/);
  });
});

describe('ClippingsRow', () => {
  const clip = (url: string | null) => ({ id: 'c1', releaseGroupId: 'rg', url, sourceLabel: 'The Wire', scoreRaw: null, note: 'Still forward-looking.', createdAt: '2026-09-30T08:00:00.000Z' });
  const bundle = (url: string | null) => ({ releaseGroupId: 'rg', fetchedAt: null, gathering: false, external: [], links: [], clippings: [clip(url)], own: null, listens: [] });
  const render = (url: string | null) => renderToStaticMarkup(<QueryHost><ClippingsRow releaseGroupId="rg" bundle={bundle(url)} /></QueryHost>);

  it('an http(s) link opens elsewhere with noopener; any other URL is plain text, never an href', () => {
    const ok = render('https://thewire.co.uk/1');
    expect(linkTag(ok, 'Open the clipping')).toMatch(/href="https:\/\/thewire\.co\.uk\/1" target="_blank" rel="noopener noreferrer"/);
    const bad = render('javascript:alert(1)');
    expect(bad).not.toContain('href="javascript:');
    expect(bad).not.toContain('Open the clipping"');
    expect(text(bad)).toContain('javascript:alert(1)');
    expect(render(null)).not.toContain('Open the clipping"');
  });
});

/* ---- helpers ---- */

function QueryHost({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

/** The first <button> in a rendered element tree (no DOM here). */
function findButton(node: ReactNode): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement(node)) return Array.isArray(node) ? node.map(findButton).find(Boolean) ?? null : null;
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.type === 'button') return el;
  return findButton(el.props['children'] as ReactNode);
}
