import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlbumEditionsPanel } from './AlbumEditionsPanel';
import type { Edition, EditionsData } from '../hooks';

const edition = (n: number, owned = false): Edition => ({
  releaseId: `r${n}`,
  mbid: `00000000-0000-0000-0000-00000000000${n}`,
  title: 'Album',
  date: `200${n}`,
  country: 'GB',
  labels: [{ name: 'Label', catalogNumber: `CAT${n}` }],
  media: [{ format: 'CD', trackCount: 10 }],
  trackCount: 10,
  owned,
  ownedByOtherAlbums: 0,
});

const data = (over: Partial<EditionsData>): EditionsData => ({
  fetchedAt: null,
  fetching: false,
  releaseGroupMbid: 'rg',
  editions: [],
  ...over,
});

const render = (editions: EditionsData | undefined, hasReleaseGroup = true) =>
  renderToStaticMarkup(
    <AlbumEditionsPanel
      hasReleaseGroup={hasReleaseGroup}
      editions={editions}
      onFetch={() => {}}
      fetchPending={false}
      rowAction={(e) => (e.owned ? 'This copy' : 'Use this edition')}
    />,
  );

const rowCount = (html: string) => (html.match(/<tbody>(.*)<\/tbody>/)?.[1]?.match(/<tr/g) ?? []).length;

describe('AlbumEditionsPanel', () => {
  it('shows editions we already know before any fetch, and the count matches the rows', () => {
    const html = render(data({ editions: [edition(1, true), edition(2), edition(3)] }));
    expect(html).toContain('Editions (3)');
    expect(rowCount(html)).toBe(3);
    expect(html).toContain('Showing 3 editions we know about.');
    expect(html).toContain('Fetch the full list from MusicBrainz');
    expect(html).not.toContain('not been fetched');
    // one fetch control, not two
    expect(html.match(/Fetch/g)).toHaveLength(1);
    expect(html).not.toContain('Refresh');
  });

  it('says we know of none yet when nothing is held and MusicBrainz has not been asked', () => {
    const html = render(data({}));
    expect(html).toContain('<h2 class="');
    expect(html).not.toContain('Editions (');
    expect(html).toContain("We don&#x27;t know of any editions yet.");
    expect(html).toContain('Fetch editions from MusicBrainz');
    expect(html).not.toContain('No editions found');
    expect(html).not.toContain('MusicBrainz lists no other editions');
    expect(rowCount(html)).toBe(0);
  });

  it('says MusicBrainz lists none once it has been asked and returned nothing', () => {
    const html = render(data({ fetchedAt: '2026-09-01T10:00:00.000Z' }));
    expect(html).toContain('MusicBrainz lists no other editions for this release group.');
    expect(html).not.toContain('Fetch editions from MusicBrainz');
    expect(html).toContain('Refresh');
    expect(rowCount(html)).toBe(0);
  });

  it('shows one fetching message while a fetch runs and nothing is held yet', () => {
    const html = render(data({ fetching: true }));
    expect(html.match(/Fetching editions from MusicBrainz…/g)).toHaveLength(1);
    expect(html).not.toContain('Fetch editions from MusicBrainz');
    expect(html).not.toContain('Refresh');
  });

  it('keeps showing known rows while a fetch runs', () => {
    const html = render(data({ fetching: true, editions: [edition(1), edition(2)] }));
    expect(html).toContain('Editions (2)');
    expect(rowCount(html)).toBe(2);
    expect(html).toContain('Fetching editions from MusicBrainz…');
    expect(html).not.toContain('we know about');
  });

  it('shows the fetched list with a refresh control and no fetch prompt', () => {
    const html = render(data({ fetchedAt: '2026-09-01T10:00:00.000Z', editions: [edition(1), edition(2), edition(3), edition(4)] }));
    expect(html).toContain('Editions (4)');
    expect(rowCount(html)).toBe(4);
    expect(html).toContain('Refresh');
    expect(html).not.toContain('we know about');
    expect(html).not.toContain('undefined');
  });

  it('asks for a match first when the album has no release group', () => {
    const html = render(undefined, false);
    expect(html).toContain('match this album first');
  });

  it('marks the copy across the whole row and keeps every action cell a real table cell', () => {
    const html = renderToStaticMarkup(
      <AlbumEditionsPanel
        hasReleaseGroup
        editions={data({ editions: [edition(1, true), edition(2)] })}
        onFetch={() => {}}
        fetchPending={false}
        rowAction={(e) => (e.owned ? 'Your copy' : 'Use this edition')}
      />,
    );
    const rows = html.match(/<tbody>(.*)<\/tbody>/)![1]!.match(/<tr[^>]*>/g)!;
    expect(rows[0]).toContain('aria-current="true"');
    expect(rows[1]).not.toContain('aria-current');
    // the action sits in a block inside the cell; a flex <td> broke the row's tint
    const actionCells = html.match(/<td class="[^"]*editionAction[^"]*">/g)!;
    expect(actionCells).toHaveLength(2);
    actionCells.forEach((td) => expect(td).not.toMatch(/gapActions/));
    expect(html).toMatch(/<td class="[^"]*editionAction[^"]*"><div class="[^"]*editionActionInner/);
  });

  it('shows a failed switch on its own row, under the edition it was for', () => {
    const html = renderToStaticMarkup(
      <AlbumEditionsPanel
        hasReleaseGroup
        editions={data({ editions: [edition(1, true), edition(2), edition(3)] })}
        onFetch={() => {}}
        fetchPending={false}
        rowAction={() => 'Use this edition'}
        rowNote={(e) => (e.releaseId === 'r2' ? <span role="alert">Couldn’t switch</span> : null)}
      />,
    );
    expect(rowCount(html)).toBe(4);
    const body = html.match(/<tbody>(.*)<\/tbody>/)![1]!;
    const order = [...body.matchAll(/CAT(\d)|Couldn’t switch/g)].map((m) => m[1] ?? 'note');
    expect(order).toEqual(['1', '2', 'note', '3']);
    expect(body).toMatch(/<td colSpan="6"|<td colspan="6"/);
  });
});
