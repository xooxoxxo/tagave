import { describe, expect, it } from 'vitest';
import { EMPTY_INPUT, absorb, apiKind, dropChip, shownKinds, suggestions, type GrammarContext, type SearchInput } from './searchGrammar';
import { searchRows, type SearchResult } from './SearchModal';

const all: GrammarContext = { playlists: true, player: true };
const bare: GrammarContext = { playlists: false, player: false };
const typed = (text: string, more: Partial<SearchInput> = {}): SearchInput => ({ ...EMPTY_INPUT, ...more, text });

describe('the ⌘K chips', () => {
  it('turns "@artist " typed in full into an Artist chip, keeping the words', () => {
    expect(absorb(typed('@artist fiona'), all)).toEqual({ act: null, scope: 'artist', text: 'fiona' });
    expect(absorb(typed('@artist '), all)).toEqual({ act: null, scope: 'artist', text: '' });
    expect(absorb(typed('@Songs so what'), all)).toMatchObject({ scope: 'song', text: 'so what' });
  });

  it('leaves a word still being typed, an unknown word and a second kind as text', () => {
    expect(absorb(typed('@artist'), all)).toEqual(typed('@artist'));
    expect(absorb(typed('@band x'), all)).toEqual(typed('@band x'));
    expect(absorb(typed('@album x', { scope: 'artist' }), all)).toEqual(typed('@album x', { scope: 'artist' }));
  });

  it('takes an action and a kind together, either order', () => {
    expect(absorb(typed('/play @album road'), all)).toEqual({ act: 'play', scope: 'album', text: 'road' });
    expect(absorb(typed('@playlist /shuffle '), all)).toEqual({ act: 'shuffle', scope: 'playlist', text: '' });
  });

  it('offers no chip this person cannot use', () => {
    expect(absorb(typed('@playlist x'), bare)).toEqual(typed('@playlist x'));
    expect(absorb(typed('/play x'), bare)).toEqual(typed('/play x'));
    // nothing plays an artist, nothing shuffles one song
    expect(absorb(typed('/play @artist x'), all)).toEqual(typed('@artist x', { act: 'play' }));
    expect(absorb(typed('/shuffle x', { scope: 'song' }), all)).toEqual(typed('/shuffle x', { scope: 'song' }));
  });

  it('Backspace in an empty box takes the kind off, then the action', () => {
    const both: SearchInput = { act: 'play', scope: 'album', text: '' };
    expect(dropChip(both)).toEqual({ act: 'play', scope: null, text: '' });
    expect(dropChip(dropChip(both))).toEqual(EMPTY_INPUT);
    expect(dropChip(EMPTY_INPUT)).toEqual(EMPTY_INPUT);
  });
});

describe('the ⌘K suggestions', () => {
  it('@ lists the kinds, narrowing as letters follow', () => {
    expect(suggestions(typed('@'), all)!.map((s) => s.primary)).toEqual(['@artist', '@album', '@song', '@playlist', '@label']);
    expect(suggestions(typed('@a'), all)!.map((s) => s.primary)).toEqual(['@artist', '@album']);
    expect(suggestions(typed('@tr'), all)!.map((s) => s.primary)).toEqual(['@song']);
    expect(suggestions(typed('@'), bare)!.map((s) => s.primary)).not.toContain('@playlist');
  });

  it('/ lists the commands; actions only with a player', () => {
    expect(suggestions(typed('/'), all)!.map((s) => s.primary)).toEqual(['/play', '/queue', '/shuffle', '/go', '/theme']);
    expect(suggestions(typed('/'), bare)!.map((s) => s.primary)).toEqual(['/go', '/theme']);
    expect(suggestions(typed('/s'), all)!.map((s) => s.primary)).toEqual(['/shuffle']);
    // with a kind chip, only what works on it, and no /go or /theme
    expect(suggestions(typed('/', { scope: 'song' }), all)!.map((s) => s.primary)).toEqual(['/play', '/queue']);
  });

  it('/go and /theme offer their choices', () => {
    expect(suggestions(typed('/go '), all)!.map((s) => s.primary)).toEqual(['/go albums', '/go artists', '/go collection', '/go playlists', '/go settings']);
    expect(suggestions(typed('/go a'), bare)!.map((s) => s.primary)).toEqual(['/go albums', '/go artists']);
    expect(suggestions(typed('/theme d'), all)).toEqual([{ type: 'theme', primary: '/theme dark', secondary: 'Dark', target: 'dark' }]);
  });

  it('is null for an ordinary search', () => {
    expect(suggestions(typed('fiona'), all)).toBeNull();
    expect(suggestions(typed('fiona', { scope: 'artist' }), all)).toBeNull();
    expect(suggestions(typed('a/b'), all)).toBeNull();
  });
});

describe('the ⌘K results', () => {
  const data: SearchResult = {
    albums: [{ id: 'a1', title: 'Tidal', artist: 'Fiona Apple', year: 1996, trackCount: 10 }],
    artists: [{ id: 'r1', name: 'Fiona Apple', albumCount: 5 }],
    tracks: [{ id: 't1', title: 'Criminal', albumId: 'a1', albumTitle: 'Tidal', artist: 'Fiona Apple' }],
    labels: [{ name: 'Clean Slate', albumCount: 3 }],
  };
  const playlists = [{ id: 'p1', name: 'Fiona mornings', tracks: 12, durationMs: 0, covers: [], updatedAt: '', mine: true, collaborative: false }];

  it('shows only the chip\'s kind', () => {
    expect(searchRows(data, 'fiona', true, false, { kinds: shownKinds({ act: null, scope: 'artist' }) }).map((r) => r.type)).toEqual(['artist']);
    expect(searchRows(data, 'clean', true, false, { kinds: shownKinds({ act: null, scope: 'label' }) }).map((r) => r.type)).toEqual(['label']);
  });

  it('matches playlists by name here, accents and case aside', () => {
    expect(searchRows(undefined, 'FIÓNA', false, false, { kinds: shownKinds({ act: null, scope: 'playlist' }), playlists }))
      .toEqual([{ type: 'playlist', id: 'p1', primary: 'Fiona mornings', secondary: '12 songs' }]);
  });

  it('an action shows only what it works on', () => {
    expect(searchRows(data, 'fiona', true, false, { kinds: shownKinds({ act: 'play', scope: null }), playlists }).map((r) => r.type))
      .toEqual(['album', 'track', 'playlist']);
    expect(searchRows(data, 'fiona', true, false, { kinds: shownKinds({ act: 'shuffle', scope: null }), playlists }).map((r) => r.type))
      .toEqual(['album', 'playlist']);
  });

  it('asks the server for one kind only when a chip says so', () => {
    expect(apiKind('song')).toBe('tracks');
    expect(apiKind('label')).toBe('labels');
    expect(apiKind('playlist')).toBeNull();
    expect(apiKind(null)).toBeNull();
  });
});
