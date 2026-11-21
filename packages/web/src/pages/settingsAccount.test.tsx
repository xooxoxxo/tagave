/**
 * Your settings › Account (spec §6): one group, Name typed with its one
 * Save, Email and Role as values.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountView, type AccountViewProps } from './SettingsAccountPage';

const noop = () => {};
const props = (over: Partial<AccountViewProps> = {}): AccountViewProps => ({
  name: 'Robin', email: 'robin@example.com', role: 'editor', draft: 'Robin', onDraft: noop, onSave: noop, pending: false, state: null, detail: null, ...over,
});
const render = (over: Partial<AccountViewProps> = {}) => renderToStaticMarkup(<AccountView {...props(over)} />);
const saveButton = (html: string) => /<button[^>]*>(?:(?!<\/button>)[\s\S])*Save(<\/span>)?<\/button>/.exec(html)?.[0] ?? '';

describe('Your settings › Account', () => {
  it('Profile is one group: Name, Email, Role', () => {
    const html = render();
    expect(html).toMatch(/<section aria-label="Profile"/);
    expect(html).toMatch(/<h3[^>]*>Profile<\/h3>/);
    const name = html.indexOf('>Name<');
    const email = html.indexOf('>Email<');
    const role = html.indexOf('>Role<');
    expect(name).toBeGreaterThan(-1);
    expect(name).toBeLessThan(email);
    expect(email).toBeLessThan(role);
    expect(html).toContain('robin@example.com');
    expect(html).toContain('Editor');
    expect(html).toMatch(/<input[^>]*maxLength="255"/);
    expect(html).toMatch(/<input[^>]*autoComplete="name"/);
    expect(html).not.toMatch(/<h2/);
  });

  it('Save waits for a new name', () => {
    expect(saveButton(render())).toMatch(/disabled/);
    expect(saveButton(render({ draft: '  ' }))).toMatch(/disabled/);
    expect(saveButton(render({ draft: 'Robin Doe' }))).not.toMatch(/disabled/);
  });

  it('saved and failed', () => {
    expect(render({ state: 'saved' })).toMatch(/role="status"[^>]*>✓ Saved</);
    expect(render({ state: 'failed' })).toMatch(/role="alert"[^>]*>Not saved</);
  });
});
