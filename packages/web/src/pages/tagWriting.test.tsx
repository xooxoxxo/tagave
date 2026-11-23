/**
 * Settings › Tag writing on the settings layout (spec §6): Tag writes is
 * Off and On, the policy's choices save when changed, the separator (a
 * typed field) with the group's one Save.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TagPolicies } from '@tagave/shared';
import { TagWritingView, type TagWritingViewProps } from './SettingsTagWritesPage';

const POLICY: TagPolicies = { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' };
const render = (over: Partial<TagWritingViewProps> = {}) => renderToStaticMarkup(
  <TagWritingView
    enabled
    writable={['/music']}
    policy={POLICY}
    separator={POLICY.multiValueSeparator}
    onWrites={vi.fn()}
    onPolicy={vi.fn()}
    onSeparator={vi.fn()}
    onSaveSeparator={vi.fn()}
    {...over}
  />,
);
/** The markup without the hints behind `?`. */
const shown = (html: string) => html.replace(/<div[^>]* hidden="">[\s\S]*?<\/div>/g, '');

describe('Settings › Tag writing', () => {
  it('Tag writes is Off and On, not a button', () => {
    const html = render();
    expect(html).toMatch(/<section aria-label="Tag writes"/);
    expect(html).toMatch(/role="radiogroup" aria-label="Tag writes"/);
    expect(html).not.toContain('Turn on');
    expect(html).not.toContain('Turn off');
    expect(html).not.toMatch(/<h2/);
  });

  it('the policy’s choices save at once, the separator with Save', () => {
    const html = render();
    expect(html).toMatch(/<section aria-label="Default write policy"/);
    expect(html).toContain('>Preset</span>');
    expect(html).toContain('>MP3 tags</span>');
    expect(html).not.toContain('>Separator</span>');
    expect(html).not.toMatch(/>Save</);
    const v23 = render({ policy: { ...POLICY, id3Version: '2.3' } });
    expect(v23).toContain('>Separator</span>');
    expect(v23).toMatch(/<button[^>]*disabled=""[^>]*>(<span[^>]*>)?Save</);
    const typed = render({ policy: { ...POLICY, id3Version: '2.3' }, separator: ' / ' });
    expect(typed).toMatch(/>Save</);
    expect(typed).not.toMatch(/<button[^>]*disabled=""[^>]*>(<span[^>]*>)?Save</);
  });

  it('labels without asides', () => {
    const html = render();
    expect(html).toContain('>ID3v2.4</option>');
    expect(html).toContain('>ID3v2.3</option>');
    expect(html).toContain('>Canonical IDs + fill</option>');
    expect(shown(html)).not.toContain('(UTF-8, recommended)');
    expect(shown(html)).not.toContain('(recommended)');
    expect(html).not.toContain('Reset');
    expect(html).not.toContain('Saving...');
  });

  it('Writable folders lists the folders that will really be written', () => {
    const value = (html: string) => html.slice(html.indexOf('>Writable folders<'));
    expect(value(render({ writable: ['/music'] }))).toContain('/music');
    expect(value(render({ writable: [] }))).toMatch(/>None</);
    // the library's switch off: nothing is written, whatever the folders allow
    const off = value(render({ enabled: false, writable: ['/music'] }));
    expect(off).toMatch(/>None</);
    expect(off).not.toContain('/music');
    expect(render({ writable: [] })).not.toContain('No folder allows writes');
  });

  it('a failed choice says so in its group', () => {
    expect(render({ policyStatus: { state: 'failed', detail: null } })).toMatch(/role="alert">Not saved</);
    expect(render({ writesStatus: { state: 'saved' } })).toContain('✓ Saved');
  });
});
