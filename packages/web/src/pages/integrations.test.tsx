/**
 * Settings › Modules › Integrations on the settings layout (spec §6): one
 * group under the Modules list, anchored for `/settings/modules#integrations`.
 * The Contact saves with its own Save; the Discogs token and the AcoustID
 * key are secrets with their own Set / Replace / Forget; Fingerprinting
 * saves when changed. The Discogs attribution stays in view.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LibrarySettingsView } from '@tagave/shared';
import { SettingsSave } from '../components/ui';
import { readFileSync } from 'node:fs';
import { IntegrationsPending, IntegrationsView, type IntegrationsViewProps } from './SettingsProvidersPage';

const SETTINGS: Pick<LibrarySettingsView, 'contactString' | 'discogsTokenSet' | 'discogsTokenHint' | 'acoustidKeySet' | 'acoustidKeyHint' | 'fingerprintingEnabled'> = {
  contactString: 'robin@example.com',
  discogsTokenSet: true,
  discogsTokenHint: 'a1b2',
  acoustidKeySet: false,
  acoustidKeyHint: null,
  fingerprintingEnabled: false,
};

const props = (over: Partial<IntegrationsViewProps> = {}): IntegrationsViewProps => ({
  settings: SETTINGS,
  contact: SETTINGS.contactString ?? '',
  onContact: vi.fn(),
  onSaveContact: vi.fn(),
  onSetSecret: vi.fn(),
  onForgetSecret: vi.fn(),
  onFingerprinting: vi.fn(),
  onLinkDiscogs: vi.fn(),
  ...over,
});
const render = (over: Partial<IntegrationsViewProps> = {}) => renderToStaticMarkup(<IntegrationsView {...props(over)} />);

/** Every element in a tree, through children and every element-valued prop. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...Object.values(el.props).flatMap((v) => (Array.isArray(v) || isValidElement(v) ? elements(v as ReactNode) : []))];
}

/** The text of every hint behind a `?` (HelpToggle's hidden region). */
const hidden = (html: string) => [...html.matchAll(/<div[^>]*hidden=""[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]).join('\n');

describe('Settings › Modules › Integrations', () => {
  it('one group, anchored', () => {
    const html = render();
    expect(html).toMatch(/<section id="integrations" aria-label="Integrations"/);
    expect(html.match(/<section /g)).toHaveLength(1);
    expect(html).not.toMatch(/<h2/);
  });

  it('the anchor is there while the settings load', () => {
    expect(renderToStaticMarkup(<IntegrationsPending />)).toMatch(/^<section id="integrations" aria-label="Integrations"/);
    const page = readFileSync(new URL('./SettingsProvidersPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('if (!settings || !draft) return <IntegrationsPending />;');
    expect(page).not.toMatch(/return null/);
  });

  it('the secrets are their own action', () => {
    const html = render();
    expect(html).toContain('Set · ••••a1b2');
    expect(html).toMatch(/>Forget</);
    expect(html).toMatch(/>Replace</);
    // the AcoustID key, not set yet: Set, no Forget for it
    expect(html).toContain('Not set');
    expect(html.match(/>Forget</g)).toHaveLength(1);
    expect(html.match(/type="password"/g)).toHaveLength(2);
    // the Contact's Save is a button of its own, and sends the contact alone
    const onSaveContact = vi.fn();
    const saves = elements(IntegrationsView(props({ contact: 'robin@example.org', onSaveContact }))).filter((e) => e.type === SettingsSave);
    expect(saves).toHaveLength(1);
    expect(saves[0]!.props.dirty).toBe(true);
    (saves[0]!.props.onSave as () => void)();
    expect(onSaveContact).toHaveBeenCalledWith({ contactString: 'robin@example.org' });
    expect(Object.keys(onSaveContact.mock.calls[0]![0] as object)).toEqual(['contactString']);
  });

  it('the Contact waits for a change', () => {
    const save = (contact: string) => elements(IntegrationsView(props({ contact }))).find((e) => e.type === SettingsSave)!;
    expect(save('robin@example.com').props.dirty).toBe(false);
    expect(save('  ').props.dirty).toBe(false);
    expect(save('robin@example.org').props.dirty).toBe(true);
  });

  it('Fingerprinting is Off and On, saved at once', () => {
    const html = render({ settings: { ...SETTINGS, acoustidKeySet: true, acoustidKeyHint: 'zz99' } });
    expect(html).toMatch(/role="radiogroup" aria-label="Fingerprinting"/);
    expect(html).not.toContain('type="checkbox"');
    expect(render({ fingerprintStatus: { state: 'saved' } })).toContain('✓ Saved');
    // without a key: held, and the value says why
    const off = render();
    expect(off).toContain('Needs an AcoustID key');
    expect(/<input[^>]*value="on"[^>]*>/.exec(off)?.[0]).toMatch(/disabled/);
  });

  it('the attribution stays in view', () => {
    const html = render();
    expect(html).toContain('tagave uses the Discogs API but is not affiliated with, sponsored or endorsed by Discogs.');
    expect(hidden(html)).not.toContain('not affiliated');
    // the links to get a token and a key sit behind ?
    expect(hidden(html)).toContain('Get a token');
    expect(hidden(html)).toContain('Get a key');
  });

  it('no ellipsis states', () => {
    const html = render({ linking: { pending: true } });
    for (const old of ['Clearing...', 'Saving...', 'Queued...']) expect(html).not.toContain(old);
    expect(render({ linking: { queued: true } })).toMatch(/role="status">Queued</);
  });
});
