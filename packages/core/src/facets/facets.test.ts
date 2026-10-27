import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createFacets, createRegistry, defineApp, defineCast, defineFacet, defineModule, ledgerEntries, moduleContext, registry, relayOf, scopeArgs, versionMeets,
  APPS, MODULES, FACETS, ALBUM_CRITIC_SCORES, CORE_API, MUSIC_APP,
  type FacetContext, type FacetReader, type ModuleContext,
} from './index.js';

const on: ModuleContext = moduleContext({ mc: true });
const off: ModuleContext = moduleContext({ mc: false });

const rating1 = defineFacet({ name: 'album.rating', version: '1.2', scope: 'person', cardinality: 'one', schema: z.object({ rating: z.number() }) });
const provider = (version: string, id = 'library', enabled = true) =>
  defineModule({ id, version: '1.0.0', provides: [{ facet: 'album.rating', version }], consumes: [], enabled: () => enabled });
const consumer = (range: string, enabled = true) =>
  defineModule({ id: 'stats', version: '1.0.0', provides: [], consumes: [{ facet: 'album.rating', range }], enabled: () => enabled });

describe('facet definitions', () => {
  it('names facets <kind>.<facet>@<major> and checks the version, the range and the cast', () => {
    expect(rating1.id).toBe('album.rating@1');
    expect(rating1).toMatchObject({ kind: 'album', major: 1, minor: 2 });
    expect(() => defineFacet({ name: 'Album.x', version: '1.0', scope: 'global', cardinality: 'one', schema: z.object({}) })).toThrow();
    expect(() => defineFacet({ name: 'album.x', version: '1', scope: 'global', cardinality: 'one', schema: z.object({}) })).toThrow();
    expect(() => defineModule({ id: 'x', version: '1', provides: [{ facet: 'album.rating@1', version: '1.0' }], consumes: [], enabled: () => true })).toThrow(/by name/);
    expect(() => defineModule({ id: 'x', version: '1', provides: [], consumes: [{ facet: 'album.rating', range: '>=1' }], enabled: () => true })).toThrow(/range/);
    expect(() => defineCast({ from: 'album.rating@1', to: 'album.listens@2', up: (v) => v })).toThrow();
  });

  it('tagave’s own registry is consistent: every facet a module names is defined', () => {
    expect(registry.problems()).toEqual([]);
    expect(FACETS.map((f) => f.id)).toEqual(expect.arrayContaining(['album.critic-scores@1', 'album.identity@1', 'album.wantlist-suggestion@1', 'track.playable@1']));
    expect(MODULES.filter((m) => m.builtIn).map((m) => m.id)).toEqual(['library', 'collection', 'reviews']);
  });

  it('a cross-app facet’s data leaves the album out (the entity is the key) and keeps no prose', () => {
    const ok = ALBUM_CRITIC_SCORES.schema.safeParse({ aggregate: { score: 8, tier: 'A', review_count: 2 }, reviews: [], critic_ratings: [], body: 'prose' });
    expect(ok.success).toBe(true);
    expect(ok.data).not.toHaveProperty('body');
    expect(ok.data).not.toHaveProperty('album');
  });
});

describe('compatibility rules', () => {
  const reg = (mods: ReturnType<typeof defineModule>[], casts = []) => createRegistry({ facets: [rating1], modules: mods, casts });

  it('same major, provider minor at or above the range: the feature is on', () => {
    const r = reg([provider('1.2'), consumer('^1.1')]);
    expect(r.state(on).modules.find((m) => m.id === 'stats')).toMatchObject({ enabled: true, needs: [], refused: [] });
    expect(r.canTurnOn('stats', on)).toEqual({ ok: true });
    expect(r.available('album.rating@1', on)).toBe(true);
  });

  it('provider minor below the range: the feature is off and says what it needs', () => {
    const r = reg([provider('1.0'), consumer('^1.1')]);
    expect(r.state(on).modules.find((m) => m.id === 'stats')!.needs).toEqual(['album.rating@1 (^1.1 or later)']);
  });

  it('no enabled provider: the feature is off, "needs" names the facet; the facet is unavailable', () => {
    const r = reg([provider('1.0', 'library', false), consumer('^1.0')]);
    expect(r.state(on).modules.find((m) => m.id === 'stats')!.needs).toEqual(['album.rating@1']);
    expect(r.available('album.rating@1', on)).toBe(false);
    expect(r.state(on).facets).toEqual([{ id: 'album.rating@1', available: false, version: null, providers: [] }]);
  });

  it('another major and no cast: turning on is refused, naming the facet (both ways); a cast joins them', () => {
    const r = reg([provider('2.0'), consumer('^1.0')]);
    const refused = r.canTurnOn('stats', on);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(/album\.rating@1.*album\.rating@2.*no cast/);
    expect(r.state(on).modules.find((m) => m.id === 'stats')!.refused).toHaveLength(1);
    // the provider of the new major, turned on while the old consumer runs
    const r2 = reg([provider('2.0', 'library', false), consumer('^1.0')]);
    expect(r2.canTurnOn('library', on).ok).toBe(false);
    // a declared cast: allowed
    const cast = defineCast({ from: 'album.rating@1', to: 'album.rating@2', up: (v) => v, down: (v) => v });
    const r3 = createRegistry({ facets: [rating1], modules: [provider('2.0'), consumer('^1.0')], casts: [cast] });
    expect(r3.canTurnOn('stats', on)).toEqual({ ok: true });
  });

  it('two providers: both are used, each value tagged by its source', async () => {
    const r = reg([provider('1.2', 'library'), provider('1.2', 'other'), consumer('^1.0')]);
    expect(r.state(on).facets[0]!.providers).toEqual(['library', 'other']);
    const read = (label: string, rating: number): FacetReader => async (entities) => new Map(entities.map((e) => [e.id, [{ source: { module: 'x', ref: null, label }, data: { rating }, updatedAt: null }]]));
    const facets = createFacets(r, { library: { 'album.rating@1': read('library', 4) }, other: { 'album.rating@1': read('other', 2) } });
    const got = await facets.get({ ...on, libraryId: 'lib', userId: 'u' }, { kind: 'album', id: 'rg' }, 'album.rating@1');
    expect(got.values.map((v) => [v.source.module, v.source.label, v.data])).toEqual([['library', 'library', { rating: 4 }], ['other', 'other', { rating: 2 }]]);
  });

  it('tagave: Music Connections off makes its facets unavailable and its jobs skip; the reviews module keeps critic scores on', () => {
    expect(registry.isEnabled('mc', off)).toBe(false);
    expect(registry.isEnabled('mc', on)).toBe(true);
    expect(registry.available('album.wantlist-suggestion@1', off)).toBe(false);
    expect(registry.available('album.wantlist-suggestion@1', on)).toBe(true);
    expect(registry.available('album.critic-scores@1', off)).toBe(true);
    expect(registry.state(off).facets.find((f) => f.id === 'album.critic-scores@1')!.providers).toEqual(['reviews']);
    expect(registry.state(on).facets.find((f) => f.id === 'album.critic-scores@1')!.providers).toEqual(['reviews', 'mc']);
    expect(registry.isEnabled('player', on)).toBe(false);
    expect(registry.isEnabled('player', { ...on, playerUrl: 'http://navidrome:4533' })).toBe(true);
    expect(registry.isEnabled('library', off)).toBe(true);
  });
});

describe('relayOf', () => {
  it('names the relay for a module that relays another app’s data (mc), none for a source tagave reads itself', () => {
    expect(relayOf(registry.modules, { module: 'mc', ref: 'link-1', label: 'review-gatherer' })).toBe('review-gatherer');
    expect(relayOf(registry.modules, { module: 'reviews', ref: null, label: 'CritiqueBrainz' })).toBeNull();
    expect(relayOf(registry.modules, { module: 'nobody', ref: null, label: 'x' })).toBeNull();
    expect(MODULES.filter((m) => m.relays).map((m) => m.id)).toEqual(['mc']);
  });
});

describe('facets.get', () => {
  const ctx: FacetContext = { ...on, libraryId: 'lib-1', userId: 'user-1' };

  it('hands each reader only what the facet’s scope allows', () => {
    expect(scopeArgs('global', ctx)).toEqual({ scope: 'global' });
    expect(scopeArgs('library', ctx)).toEqual({ scope: 'library', libraryId: 'lib-1' });
    expect(scopeArgs('person', ctx)).toEqual({ scope: 'person', libraryId: 'lib-1', userId: 'user-1' });
    expect(scopeArgs('person', { libraryId: 'lib-1', userId: null })).toBeNull();
    expect(scopeArgs('library', { libraryId: null, userId: 'u' })).toBeNull();
  });

  it('filters by scope: a person facet without a person reads nothing; the reader sees the caller’s scope', async () => {
    const seen: unknown[] = [];
    const reader: FacetReader = async (entities, scope) => {
      seen.push(scope);
      return new Map(entities.map((e) => [e.id, [{ source: { module: 'x', ref: 'link-1', label: 'review-gatherer' }, data: { aggregate: { score: 8, tier: null, review_count: 1 }, reviews: [], critic_ratings: [] }, updatedAt: null }]]));
    };
    const facets = createFacets(registry, { mc: { 'album.critic-scores@1': reader } });
    const got = await facets.get(ctx, { kind: 'album', id: 'rg-1' }, 'album.critic-scores@1');
    expect(seen).toEqual([{ scope: 'person', libraryId: 'lib-1', userId: 'user-1' }]);
    expect(got).toMatchObject({ available: true, version: '1.0' });
    expect(got.values[0]!.source).toEqual({ module: 'mc', ref: 'link-1', label: 'review-gatherer' });
    const anon = await facets.get({ ...ctx, userId: null }, { kind: 'album', id: 'rg-1' }, 'album.critic-scores@1');
    expect(anon.values).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('fails closed: a module that is off is not read, an unknown facet is unavailable, a value off-schema is left out', async () => {
    let called = 0;
    const reader: FacetReader = async (entities) => {
      called++;
      return new Map(entities.map((e) => [e.id, [
        { source: { module: 'mc', ref: null, label: 'a' }, data: { reason: 'good', score: 7, suggested_at: '2026-10-01T00:00:00Z' }, updatedAt: null },
        { source: { module: 'mc', ref: null, label: 'b' }, data: { reason: 5 }, updatedAt: null },
      ]]));
    };
    const facets = createFacets(registry, { mc: { 'album.wantlist-suggestion@1': reader } });
    const offResult = await facets.get({ ...ctx, ...off }, { kind: 'album', id: 'rg' }, 'album.wantlist-suggestion@1');
    expect(offResult).toEqual({ available: false, version: null, values: [] });
    expect(called).toBe(0);
    const got = await facets.get(ctx, { kind: 'album', id: 'rg' }, 'album.wantlist-suggestion@1');
    expect(got.values.map((v) => v.source.label)).toEqual(['a']);
    expect((await facets.get(ctx, { kind: 'album', id: 'rg' }, 'album.nope@1')).available).toBe(false);
  });

  it('a major mismatch without a cast fails closed: the provider’s values are left out', async () => {
    const v2 = defineFacet({ name: 'album.rating', version: '2.0', scope: 'person', cardinality: 'one', schema: z.object({ stars: z.number() }) });
    const r = createRegistry({ facets: [rating1, v2], modules: [provider('2.0')] });
    let called = 0;
    const facets = createFacets(r, { library: { 'album.rating@1': async () => { called++; return new Map(); } } });
    const got = await facets.get(ctx, { kind: 'album', id: 'rg' }, 'album.rating@1');
    expect(got.available).toBe(false);
    expect(called).toBe(0);
  });

  it('a `one` facet picks what a person set, then what the files carry, then a module’s', async () => {
    const r = createRegistry({ facets: [rating1], modules: [provider('1.2')] });
    const facets = createFacets(r, { library: { 'album.rating@1': async (es) => new Map(es.map((e) => [e.id, [
      { source: { module: 'library', ref: null, label: 'mc', kind: 'module' as const }, data: { rating: 1 }, updatedAt: null },
      { source: { module: 'library', ref: null, label: 'tags', kind: 'embedded' as const }, data: { rating: 2 }, updatedAt: null },
      { source: { module: 'library', ref: null, label: 'you', kind: 'person' as const }, data: { rating: 3 }, updatedAt: null },
    ]])) } });
    const got = await facets.get(ctx, { kind: 'album', id: 'rg' }, 'album.rating@1');
    expect(got.pick?.source.label).toBe('you');
  });
});

describe('manifest v2: apps, compatibility, the module ledger', () => {
  const rating = defineFacet({ name: 'album.rating', version: '1.0', scope: 'person', cardinality: 'one', schema: z.object({}) });
  const books = (version = '1.0.0', builtIn = false) => defineApp({ id: 'books', version, builtIn, fileTypes: ['epub'] });
  const ext = defineModule({ id: 'opds', version: '1.0.0', compatibleWith: [{ app: 'books', range: '^1.1' }], provides: [], consumes: [] });

  it('reads a module’s switch from the ledger by default; an id with no row is off', () => {
    const m = defineModule({ id: 'decider', version: '1.0.0', provides: [], consumes: [] });
    expect(m).toMatchObject({ kind: 'in-process', coreApi: `^${CORE_API}`, compatibleWith: [], defaultEnabled: false, migrations: null, settingsKeys: [] });
    expect(m.enabled(moduleContext({ decider: true }))).toBe(true);
    expect(m.enabled(moduleContext({}))).toBe(false);
    expect(moduleContext({ mc: true }).enabled('listen-links')).toBe(false);
  });

  it('refuses a manifest built for another core API major, and a migrations folder of another id', () => {
    expect(() => defineModule({ id: 'x', version: '1.0.0', coreApi: '^2.0', provides: [], consumes: [] })).toThrow(/core API/);
    expect(() => defineApp({ id: 'x', version: '1.0.0', coreApi: '^0.9', fileTypes: [] })).toThrow(/core API/);
    expect(() => defineModule({ id: 'x', version: '1.0.0', migrations: 'modules/y', provides: [], consumes: [] })).toThrow(/modules\/x/);
    expect(() => defineApp({ id: 'x', version: '1', fileTypes: [] })).toThrow(/semver/);
    expect(versionMeets('1.4.2', '^1.2')).toBe(true);
    expect(versionMeets('1.1.0', '^1.2')).toBe(false);
    expect(versionMeets('2.0.0', '^1.0')).toBe(false);
  });

  it('a module whose app is missing, off or out of range cannot be on, and says why', () => {
    const withApp = (a?: ReturnType<typeof books>) => createRegistry({ facets: [rating], modules: [ext], apps: a ? [a] : [] });
    const on = moduleContext({ opds: true, books: true });
    expect(withApp().isEnabled('opds', on)).toBe(false);
    expect(withApp().canTurnOn('opds', on)).toEqual({ ok: false, reason: 'opds needs the books app, which this install does not have' });
    expect(withApp().problems()).toEqual(['opds works with the books app, which no app defines']);
    expect(withApp(books('1.0.0')).canTurnOn('opds', on)).toEqual({ ok: false, reason: 'opds needs books ^1.1, and this is books 1.0.0' });
    expect(withApp(books('1.2.0')).canTurnOn('opds', moduleContext({ opds: true }))).toEqual({ ok: false, reason: 'opds needs the books app turned on' });
    expect(withApp(books('1.2.0')).isEnabled('opds', moduleContext({ opds: true }))).toBe(false);
    expect(withApp(books('1.2.0')).state(moduleContext({ opds: true })).modules[0]!.refused).toEqual(['opds needs the books app turned on']);
    expect(withApp(books('1.2.0')).isEnabled('opds', on)).toBe(true);
    expect(withApp(books('1.2.0', true)).isEnabled('opds', moduleContext({ opds: true }))).toBe(true);
    expect(() => createRegistry({ facets: [], modules: [defineModule({ id: 'books', version: '1.0.0', provides: [], consumes: [] })], apps: [books()] })).toThrow(/twice/);
  });

  it('tagave: music is the one app, built in, claiming audio; every module works with it', () => {
    expect(APPS.map((a) => a.id)).toEqual(['music']);
    expect(MUSIC_APP).toMatchObject({ builtIn: true, fileTypes: ['audio'], grouping: { queue: 'cluster.dir' } });
    expect(registry.appEnabled('music', moduleContext({}))).toBe(true);
    for (const m of MODULES.filter((x) => !x.builtIn)) expect(m.compatibleWith, m.id).toEqual([{ app: 'music', range: '^1.0' }]);
    expect(registry.state(moduleContext({})).modules.flatMap((m) => m.refused)).toEqual([]);
  });

  it('the ledger rows a boot syncs: the app and every in-process module at its default (the player is the updater’s)', () => {
    expect(ledgerEntries()).toEqual([
      { id: 'music', kind: 'app', version: '1.0.0', defaultEnabled: true },
      { id: 'mc', kind: 'in-process', version: '1.0.0', defaultEnabled: false },
      { id: 'listen-links', kind: 'in-process', version: '1.0.0', defaultEnabled: false },
      { id: 'playlists', kind: 'in-process', version: '1.0.0', defaultEnabled: true },
    ]);
  });
});
