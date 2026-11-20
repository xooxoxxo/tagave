/**
 * Settings › Library › Naming and Drop pool on the settings layout (spec
 * §6): groups of rows, an empty value a word, a save's outcome in its group.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DropPoolView, NamingView } from '@tagave/shared';
import { NamingSettingsView } from './NamingSettings';
import { DropPoolSettingsView } from './DropPoolSettings';

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const NAMING: NamingView = {
  rules: { folder: '{albumartist}/{album}', file: '{track:02} {title}', special: [], leaveAlone: [] },
  saved: true,
  detected: null,
  examples: [],
  problems: {},
};
const ROOT = '11111111-1111-4111-8111-111111111111';
const POOL: DropPoolView = {
  enabled: true, scanRootId: ROOT, dirPath: '_Inbox', path: '/music/_Inbox', hostPath: null,
  roots: [{ id: ROOT, path: '/music' }], counts: { waiting: 1, inbox: 3, imported: 42, skipped: 0 }, problem: null, state: 'ready',
};

describe('Settings › Library › Naming', () => {
  const render = (over: Partial<Parameters<typeof NamingSettingsView>[0]> = {}) =>
    renderToStaticMarkup(<NamingSettingsView view={NAMING} onSave={vi.fn()} {...over} />);

  it('examples never show a dash', () => {
    const html = render();
    expect(html).toMatch(/<section aria-label="Examples"/);
    expect(html).toContain('No examples');
    expect(html).not.toContain('—');
  });

  it('groups Naming, Leave alone, Examples; one Save, Reset beside it', () => {
    const html = render();
    expect(html.indexOf('aria-label="Naming"')).toBeGreaterThan(-1);
    expect(html.indexOf('aria-label="Naming"')).toBeLessThan(html.indexOf('aria-label="Leave alone"'));
    expect(html.indexOf('aria-label="Leave alone"')).toBeLessThan(html.indexOf('aria-label="Examples"'));
    for (const label of ['Folder', 'File', 'Soundtrack', 'Compilation']) expect(html).toContain(`>${label}</span>`);
    expect(html.match(/>Save</g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(<span[^>]*>)?Save</);
    expect(html).toContain('>Reset<');
    expect(html).not.toMatch(/<h2/);
  });
});

describe('Settings › Library › Drop pool', () => {
  const render = (over: Partial<Parameters<typeof DropPoolSettingsView>[0]> = {}) =>
    renderToStaticMarkup(<DropPoolSettingsView view={POOL} onPut={vi.fn()} {...over} />);

  it('the drop pool’s error is the group’s status, not a toast', () => {
    expect(source('./DropPoolSettings.tsx')).not.toContain('showToast');
    expect(render({ state: 'failed', detail: 'folder is read-only' })).toMatch(/role="alert">Folder is read-only\.</);
  });

  it('Off and On saves at once, the folder with Save', () => {
    const html = render();
    expect(html).toMatch(/<section aria-label="Drop pool"/);
    expect(html).toMatch(/role="radiogroup" aria-label="Drop pool"/);
    expect(html).toContain('>Folder</span>');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(<span[^>]*>)?Save</);
    expect(html).toContain('Ready · /music/_Inbox');
    expect(html).not.toMatch(/<h2/);
  });

  it('off shows the switch and the counts, no folder to type', () => {
    const html = render({ view: { ...POOL, enabled: false, state: null } });
    expect(html).not.toContain('>Folder</span>');
    expect(html).not.toMatch(/>Save</);
    expect(html).toContain('>Inbox</span>');
  });
});
