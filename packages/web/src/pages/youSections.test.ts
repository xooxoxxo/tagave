/**
 * Your settings is the person's own: what it lists (spec §2).
 */
import { describe, expect, it } from 'vitest';
import { YOU_SECTIONS, youGate, youModules, youNav, type YouModules } from './youSections';

const allNull: YouModules = { player: null, dj: null, listenElsewhere: null, connections: null };
const values = (modules: YouModules) => youNav(modules).map((s) => s.value);

describe('youNav', () => {
  it('everyone has Account and Appearance', () => {
    expect(values(allNull)).toEqual(['account', 'appearance']);
  });

  it('a module section shows while its module is on', () => {
    expect(values({ player: true, dj: false, listenElsewhere: true, connections: null })).toEqual(['account', 'appearance', 'listening', 'listen-elsewhere']);
  });

  it('order with every module on', () => {
    expect(values({ player: true, dj: true, listenElsewhere: true, connections: true })).toEqual(['account', 'appearance', 'listening', 'dj', 'listen-elsewhere', 'connections']);
  });

  it('custom theme is unlisted', () => {
    const on: YouModules = { player: true, dj: true, listenElsewhere: true, connections: true };
    expect(values(on)).not.toContain('custom-theme');
    expect(values(allNull)).not.toContain('custom-theme');
    expect(YOU_SECTIONS.find((s) => s.value === 'custom-theme')?.unlisted).toBe(true);
  });
});

describe('youGate', () => {
  const on: YouModules = { player: true, dj: true, listenElsewhere: true, connections: true };

  it('a Your settings module section that is off goes to Account', () => {
    expect(youGate('dj', { ...on, dj: false })).toBe('/you/account');
    expect(youGate('listening', { ...on, player: false })).toBe('/you/account');
    expect(youGate('listen-elsewhere', { ...on, listenElsewhere: false })).toBe('/you/account');
    expect(youGate('connections', { ...on, connections: false })).toBe('/you/account');
  });

  it('a module section waits while its module loads', () => {
    for (const s of ['listening', 'dj', 'listen-elsewhere', 'connections']) expect(youGate(s, allNull)).toBe('wait');
  });

  it('a section that is on, or has no module, opens', () => {
    for (const s of ['listening', 'dj', 'listen-elsewhere', 'connections']) expect(youGate(s, on)).toBeNull();
    for (const s of ['account', 'appearance', 'custom-theme']) {
      expect(youGate(s, allNull)).toBeNull();
      expect(youGate(s, { player: false, dj: false, listenElsewhere: false, connections: false })).toBeNull();
    }
  });
});

describe('youModules', () => {
  it('youModules maps facet ids', () => {
    expect(youModules({ enabled: { dj: true, 'listen-links': false, mc: true }, playerInstalled: false }))
      .toEqual({ player: false, dj: true, listenElsewhere: false, connections: true });
    expect(youModules({ enabled: null, playerInstalled: true }))
      .toEqual({ player: true, dj: null, listenElsewhere: null, connections: null });
    expect(youModules({ enabled: null, playerInstalled: null })).toEqual(allNull);
  });

  it('a module the server does not name is off once the facets are known', () => {
    expect(youModules({ enabled: {}, playerInstalled: null }))
      .toEqual({ player: null, dj: false, listenElsewhere: false, connections: false });
  });
});
