/**
 * The ⌘K box's small grammar (owner, 2026-11-04: "commands with slash or @
 * helping out with artist, album, song selection ... @artist will add a
 * fixed artist tag showing we're searching for that").
 *
 *   @artist fiona       a kind chip: only artists, then the words
 *   @album  @song  @playlist  @label
 *   /play fiona         an action chip: Enter plays the highlighted result
 *   /queue  /shuffle    (Add to queue, Shuffle) on albums, songs, playlists
 *   /go albums          straight to a page: albums, artists, collection, playlists, settings
 *   /theme dark         light, dark or auto
 *
 * Typing the whole word and a space ("@artist ") turns it into its chip;
 * so does picking it from the list (Enter or Tab). Backspace in an empty
 * box takes the last chip off. Everything here is pure, so the rules are
 * tested without a DOM; SearchModal draws them.
 */

export type ScopeKind = 'artist' | 'album' | 'song' | 'playlist' | 'label';
export type ActKind = 'play' | 'queue' | 'shuffle';
export type GoTarget = 'albums' | 'artists' | 'collection' | 'playlists' | 'settings';
export type ThemeTarget = 'light' | 'dark' | 'auto';

export interface ScopeDef { kind: ScopeKind; word: string; chip: string; aliases: readonly string[] }
export interface ActDef { kind: ActKind; word: string; chip: string; kinds: readonly ScopeKind[] }

export const SCOPES: readonly ScopeDef[] = [
  { kind: 'artist', word: 'artist', chip: 'Artist', aliases: ['artists'] },
  { kind: 'album', word: 'album', chip: 'Album', aliases: ['albums'] },
  { kind: 'song', word: 'song', chip: 'Song', aliases: ['songs', 'track', 'tracks'] },
  { kind: 'playlist', word: 'playlist', chip: 'Playlist', aliases: ['playlists'] },
  { kind: 'label', word: 'label', chip: 'Label', aliases: ['labels'] },
];

/** What each action works on: there is no "play an artist" or "shuffle one song". */
export const ACTS: readonly ActDef[] = [
  { kind: 'play', word: 'play', chip: 'Play', kinds: ['album', 'song', 'playlist'] },
  { kind: 'queue', word: 'queue', chip: 'Queue', kinds: ['album', 'song', 'playlist'] },
  { kind: 'shuffle', word: 'shuffle', chip: 'Shuffle', kinds: ['album', 'playlist'] },
];

export const GO_TARGETS: readonly { target: GoTarget; label: string }[] = [
  { target: 'albums', label: 'Albums' },
  { target: 'artists', label: 'Artists' },
  { target: 'collection', label: 'Physical collection' },
  { target: 'playlists', label: 'Playlists' },
  { target: 'settings', label: 'Settings' },
];

export const THEME_TARGETS: readonly { target: ThemeTarget; label: string }[] = [
  { target: 'light', label: 'Light' },
  { target: 'dark', label: 'Dark' },
  { target: 'auto', label: 'Auto' },
];

/** The box: the chips in front of the field, and what is typed after them. */
export interface SearchInput {
  act: ActKind | null;
  scope: ScopeKind | null;
  text: string;
}

export const EMPTY_INPUT: SearchInput = { act: null, scope: null, text: '' };

/** What this person can use here: playlists (the module), the player (Play, Queue, Shuffle). */
export interface GrammarContext {
  playlists: boolean;
  player: boolean;
}

const scopeOf = (word: string): ScopeDef | undefined => {
  const w = word.toLowerCase();
  return SCOPES.find((s) => s.word === w || s.aliases.includes(w));
};
const actOf = (word: string): ActDef | undefined => ACTS.find((a) => a.word === word.toLowerCase());

export const scopeDef = (kind: ScopeKind): ScopeDef => SCOPES.find((s) => s.kind === kind)!;
export const actDef = (kind: ActKind): ActDef => ACTS.find((a) => a.kind === kind)!;

/** The kinds an @ chip can take now: playlists only with the module, and only what the action works on. */
export function scopesFor(input: Pick<SearchInput, 'act'>, ctx: GrammarContext): ScopeDef[] {
  const allowed = input.act ? actDef(input.act).kinds : null;
  return SCOPES.filter((s) => (s.kind !== 'playlist' || ctx.playlists) && (!allowed || allowed.includes(s.kind)));
}

/** The actions a / can take now: with a player only, and only those that work on the kind chosen. */
export function actsFor(input: Pick<SearchInput, 'scope'>, ctx: GrammarContext): ActDef[] {
  if (!ctx.player) return [];
  return ACTS.filter((a) => !input.scope || a.kinds.includes(input.scope));
}

export function goTargets(ctx: GrammarContext): typeof GO_TARGETS[number][] {
  return GO_TARGETS.filter((g) => g.target !== 'playlists' || ctx.playlists);
}

/**
 * A word typed in full and a space after it ("@artist ", "/play ") becomes
 * its chip; the rest stays in the box. Repeats until nothing more turns.
 * A chip this context does not offer stays as typed text.
 */
export function absorb(input: SearchInput, ctx: GrammarContext): SearchInput {
  let next = input;
  for (;;) {
    const m = next.text.match(/^([@/])(\S+)\s+([\s\S]*)$/);
    if (!m) return next;
    const [, sigil, word, rest] = m as unknown as [string, string, string, string];
    if (sigil === '@' && !next.scope) {
      const s = scopeOf(word);
      if (!s || !scopesFor(next, ctx).some((x) => x.kind === s.kind)) return next;
      next = { ...next, scope: s.kind, text: rest };
      continue;
    }
    if (sigil === '/' && !next.act) {
      const a = actOf(word);
      if (!a || !actsFor(next, ctx).some((x) => x.kind === a.kind)) return next;
      next = { ...next, act: a.kind, text: rest };
      continue;
    }
    return next;
  }
}

/** Backspace in an empty box: the last chip comes off (the kind, then the action). */
export function dropChip(input: SearchInput): SearchInput {
  if (input.scope) return { ...input, scope: null };
  if (input.act) return { ...input, act: null };
  return input;
}

export type Suggestion =
  | { type: 'suggest'; primary: string; secondary: string; insert: string }
  | { type: 'go'; primary: string; secondary: string; target: GoTarget }
  | { type: 'theme'; primary: string; secondary: string; target: ThemeTarget };

const startsWith = (word: string, typed: string) => word.startsWith(typed.toLowerCase());

/**
 * What a leading @ or / offers while it is being typed: the kinds, the
 * commands, or a command's choices (/go albums, /theme dark). Null when the
 * box is an ordinary search.
 */
export function suggestions(input: SearchInput, ctx: GrammarContext): Suggestion[] | null {
  const { text } = input;
  const at = text.match(/^@(\S*)$/);
  if (at) {
    if (input.scope) return [];
    const typed = at[1]!;
    return scopesFor(input, ctx)
      .filter((s) => startsWith(s.word, typed) || s.aliases.some((a) => startsWith(a, typed)))
      .map((s) => ({ type: 'suggest', primary: `@${s.word}`, secondary: s.chip, insert: `@${s.word} ` }));
  }
  const sub = text.match(/^\/(go|theme)\s+(\S*)$/i);
  if (sub && !input.act && !input.scope) {
    const typed = sub[2]!.toLowerCase();
    if (sub[1]!.toLowerCase() === 'go') {
      return goTargets(ctx).filter((g) => startsWith(g.target, typed))
        .map((g) => ({ type: 'go', primary: `/go ${g.target}`, secondary: g.label, target: g.target }));
    }
    return THEME_TARGETS.filter((t) => startsWith(t.target, typed))
      .map((t) => ({ type: 'theme', primary: `/theme ${t.target}`, secondary: t.label, target: t.target }));
  }
  const slash = text.match(/^\/(\S*)$/);
  if (slash) {
    const typed = slash[1]!;
    const out: Suggestion[] = input.act ? [] : actsFor(input, ctx)
      .filter((a) => startsWith(a.word, typed))
      .map((a) => ({ type: 'suggest', primary: `/${a.word}`, secondary: a.chip, insert: `/${a.word} ` }));
    if (!input.act && !input.scope) {
      if (startsWith('go', typed)) out.push({ type: 'suggest', primary: '/go', secondary: 'Go to', insert: '/go ' });
      if (startsWith('theme', typed)) out.push({ type: 'suggest', primary: '/theme', secondary: 'Theme', insert: '/theme ' });
    }
    return out;
  }
  return null;
}

/** The API's kind for a chip (`?kind=`); playlists are filtered here, not searched there. */
export function apiKind(scope: ScopeKind | null): 'albums' | 'artists' | 'tracks' | 'labels' | null {
  switch (scope) {
    case 'album': return 'albums';
    case 'artist': return 'artists';
    case 'song': return 'tracks';
    case 'label': return 'labels';
    default: return null;
  }
}

/** Result kinds a box shows: the chip's kind, else what the action works on, else all. */
export function shownKinds(input: Pick<SearchInput, 'act' | 'scope'>): ReadonlySet<ScopeKind> {
  if (input.scope) return new Set([input.scope]);
  if (input.act) return new Set(actDef(input.act).kinds);
  return new Set<ScopeKind>(['album', 'artist', 'song', 'playlist']);
}

/** Case and accents set aside, for matching playlist names here. */
export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
