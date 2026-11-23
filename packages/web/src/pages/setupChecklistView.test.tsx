/**
 * The setup checklist's steps are the settings pages' own rows: Contact and
 * the two keys are Modules › Integrations' rows (Contact with its Save, the
 * keys as secret rows with Set / Replace / Forget), the music folder is
 * Settings › Library's Add music folder (Allow writes Off/On, no checkbox).
 * The five steps keep their Done / Required / Optional.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScanRoot } from '@tagave/shared';
import { describe, expect, it, vi } from 'vitest';
import { SetupChecklistView, type SetupChecklistViewProps } from './SetupChecklistContent';
import { IntegrationsView } from './SettingsProvidersPage';

const at = '2026-11-01T10:00:00.000Z';
const root = (over: Partial<ScanRoot> = {}): ScanRoot => ({
  id: '11111111-1111-4111-8111-111111111111', libraryId: '22222222-2222-4222-8222-222222222222', path: '/music', displayName: 'Music',
  writable: true, enabled: true, pollIntervalS: 21600, validationStatus: 'ok', validationMessage: null, probeWritable: true,
  albumsFound: 0, tracksFound: 0, folderLink: null, createdAt: at, updatedAt: at, ...over,
});
const SETTINGS: SetupChecklistViewProps['settings'] = {
  contactString: null, discogsTokenSet: false, discogsTokenHint: null, acoustidKeySet: false, acoustidKeyHint: null, onboardingCompletedAt: null,
};
const render = (over: Partial<SetupChecklistViewProps> = {}) => renderToStaticMarkup(
  <SetupChecklistView
    settings={SETTINGS}
    roots={[]}
    contact=""
    onContact={vi.fn()}
    onSaveContact={vi.fn()}
    onSetSecret={vi.fn()}
    onForgetSecret={vi.fn()}
    onAdd={() => true}
    onStartScan={vi.fn()}
    {...over}
  />,
);
/** The markup of the group titled `title`, up to the end of its section. */
const group = (html: string, title: string) => {
  const at = html.indexOf(`<section aria-label="${title}"`);
  if (at < 0) throw new Error(`no ${title}`);
  return html.slice(at, html.indexOf('</section>', at));
};
/** The markup of the row labelled `label`, from its label to the end of the row. */
const row = (html: string, label: string) => {
  const at = html.indexOf(`>${label}</span>`);
  if (at < 0) throw new Error(`no ${label} row`);
  return html.slice(at, html.indexOf('</span></span>', at));
};
const integrations = (over: Partial<Parameters<typeof IntegrationsView>[0]['settings']> = {}) => renderToStaticMarkup(
  <IntegrationsView
    settings={{ contactString: null, discogsTokenSet: false, discogsTokenHint: null, acoustidKeySet: false, acoustidKeyHint: null, fingerprintingEnabled: false, ...over }}
    contact=""
    onContact={vi.fn()}
    onSaveContact={vi.fn()}
    onSetSecret={vi.fn()}
    onForgetSecret={vi.fn()}
    onFingerprinting={vi.fn()}
    onLinkDiscogs={vi.fn()}
  />,
);

describe('the setup checklist', () => {
  it('keeps its five steps and their state', () => {
    const html = render();
    for (const title of ['Contact', 'Music folder', 'Discogs token', 'AcoustID key', 'First scan']) expect(html).toContain(`<section aria-label="${title}"`);
    expect(group(html, 'Contact')).toContain('Required');
    expect(group(html, 'Music folder')).toContain('Required');
    expect(group(html, 'Discogs token')).toContain('Optional');
    expect(group(html, 'AcoustID key')).toContain('Optional');
    expect(group(html, 'First scan')).toContain('Required');
    const done = render({
      settings: { ...SETTINGS, contactString: 'robin@example.com', discogsTokenSet: true, discogsTokenHint: 'ab12', acoustidKeySet: true, onboardingCompletedAt: at },
      roots: [root()],
      contact: 'robin@example.com',
    });
    for (const title of ['Contact', 'Music folder', 'Discogs token', 'AcoustID key', 'First scan']) expect(group(done, title), title).toContain('Done');
  });

  it('Contact is the Integrations row, with its Save', () => {
    expect(row(render(), 'Contact')).toBe(row(integrations(), 'Contact'));
    const contact = row(render({ contact: 'robin@example.com' }), 'Contact');
    expect(contact).toContain('placeholder="you@example.com"');
    expect(contact).toMatch(/>Save</);
  });

  it('the two keys are the Integrations secret rows: Set, Replace, Forget', () => {
    const html = render();
    expect(row(html, 'Discogs token')).toBe(row(integrations(), 'Discogs token'));
    expect(row(html, 'AcoustID key')).toBe(row(integrations(), 'AcoustID key'));
    expect(row(html, 'Discogs token')).toContain('Not set');
    expect(row(html, 'Discogs token')).toMatch(/>Set</);
    const stored = render({ settings: { ...SETTINGS, discogsTokenSet: true, discogsTokenHint: 'ab12' } });
    expect(row(stored, 'Discogs token')).toContain('Set · ••••ab12');
    expect(row(stored, 'Discogs token')).toMatch(/>Replace</);
    expect(row(stored, 'Discogs token')).toMatch(/>Forget</);
    expect(html).not.toContain('>Clear<');
    expect(html).not.toContain('>Add token<');
  });

  it('the music folder step is Add music folder, with Allow writes Off/On', () => {
    const html = render();
    expect(html).toContain('<section aria-label="Add music folder"');
    expect(group(html, 'Add music folder')).toMatch(/role="radiogroup" aria-label="Allow writes"/);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('Allow tag writes');
  });

  it('lists the folders already added, by name and check', () => {
    const html = render({ roots: [root({ displayName: 'Robin music', validationStatus: 'missing' })] });
    const step = group(html, 'Music folder');
    expect(step).toContain('>Robin music<');
    expect(step).toContain('/music');
    expect(step).toContain('Missing');
  });

  it('First scan waits for a folder that checks out', () => {
    expect(group(render(), 'First scan')).toMatch(/<button[^>]*disabled=""[^>]*>(<span[^>]*>)?Start scan</);
    expect(group(render({ roots: [root()] }), 'First scan')).not.toMatch(/<button[^>]*disabled=""[^>]*>(<span[^>]*>)?Start scan</);
  });
});
