/**
 * Settings › Updates on the settings layout (spec §6): groups under the
 * frame's one heading; Update checks is Off and On and saves when changed,
 * the feed URL saves with its own Save.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UpdatesStatus } from '@tagave/shared';
import { UpdateChecksView, type UpdateChecksViewProps } from './SettingsUpdatesPage';

const FEED: UpdatesStatus['feed'] = {
  url: 'https://api.github.com/repos/example/tagave/releases',
  defaultUrl: 'https://api.github.com/repos/example/tagave/releases',
  custom: false,
  enabled: true,
  lockedByServer: false,
  lastCheckedAt: '2026-11-04T10:00:00Z',
  nextCheckAt: '2026-11-04T22:00:00Z',
  latest: null,
  newer: [],
  skippedVersion: null,
  error: null,
};

const render = (over: Partial<UpdateChecksViewProps> = {}) =>
  renderToStaticMarkup(<UpdateChecksView feed={FEED} url="" onUrl={vi.fn()} onEnabled={vi.fn()} onSaveUrl={vi.fn()} onCheck={vi.fn()} {...over} />);

describe('Settings › Updates', () => {
  it('no h2 of its own', () => {
    const src = readFileSync(new URL('./SettingsUpdatesPage.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/<h2/);
    expect(src).not.toMatch(/<h3/);
    expect(src).toContain('title="Update checks"');
    expect(src).toContain('title="Running now"');
  });

  it('Update checks is Off and On', () => {
    const html = render();
    expect(html).toMatch(/<section aria-label="Update checks"/);
    expect(html).toMatch(/role="radiogroup" aria-label="Update checks"/);
    expect(html).not.toContain('type="checkbox"');
    expect(html).toMatch(/>Check now</);
    expect(render({ enabledStatus: { state: 'saved' } })).toContain('✓ Saved');
    // the server decides: a value, no switch
    const locked = render({ feed: { ...FEED, lockedByServer: true } });
    expect(locked).not.toContain('radiogroup');
    expect(locked).toContain('TAGAVE_UPDATE_FEED');
  });

  it('the feed URL has its one Save, disabled until changed', () => {
    const save = (html: string) => /<button[^>]*>(?:(?!<\/button>)[\s\S])*>Save(<\/span>)?<\/button>/.exec(html)?.[0] ?? '';
    expect(save(render())).toMatch(/disabled/);
    expect(save(render({ url: 'https://api.github.com/repos/robin/tagave/releases' }))).not.toMatch(/disabled/);
    expect(render({ urlStatus: { state: 'failed', detail: 'Use a GitHub releases API URL' } })).toMatch(/role="alert">Use a GitHub releases API URL.</);
    // checks off: no feed to set
    expect(render({ feed: { ...FEED, enabled: false } })).not.toContain('>Feed<');
  });
});
