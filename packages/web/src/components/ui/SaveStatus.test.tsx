import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SaveStatus } from './SaveStatus';
import { SettingsSave } from './SettingsSave';
import { SettingsGroup } from './SettingsGroup';

const noop = () => {};
/** The Save button's opening tag. */
const saveButton = (html: string) => /<button[^>]*>/.exec(html)?.[0] ?? '';

describe('SaveStatus', () => {
  it('saved reads ✓ Saved as a status', () => {
    const html = renderToStaticMarkup(<SaveStatus state="saved" />);
    expect(html).toMatch(/<span[^>]*role="status"[^>]*>✓ Saved<\/span>/);
  });

  it("failed names the API's sentence", () => {
    const html = renderToStaticMarkup(<SaveStatus state="failed" detail="folder is read-only" />);
    expect(html).toMatch(/<span[^>]*role="alert"[^>]*>Folder is read-only\.<\/span>/);
  });

  it('failed without a detail reads Not saved', () => {
    const html = renderToStaticMarkup(<SaveStatus state="failed" />);
    expect(html).toMatch(/role="alert"[^>]*>Not saved<\/span>/);
  });

  it('null renders nothing', () => {
    expect(renderToStaticMarkup(<SaveStatus state={null} />)).toBe('');
  });
});

describe('SettingsSave', () => {
  it('Save waits for a change', () => {
    expect(saveButton(renderToStaticMarkup(<SettingsSave dirty={false} onSave={noop} />))).toMatch(/disabled/);
    const dirty = saveButton(renderToStaticMarkup(<SettingsSave dirty onSave={noop} />));
    expect(dirty).not.toMatch(/disabled/);
    const pending = saveButton(renderToStaticMarkup(<SettingsSave dirty pending onSave={noop} />));
    expect(pending).toMatch(/disabled/);
    expect(pending).toContain('aria-busy="true"');
    const waits = renderToStaticMarkup(<SettingsSave dirty reason="Set the key first" onSave={noop} />);
    expect(saveButton(waits)).toMatch(/disabled/);
    expect(waits.slice(waits.indexOf('</button>'))).toMatch(/^<\/button><span[^>]*>Set the key first<\/span>/);
  });

  it('reads Save unless told otherwise, and shows its status beside it', () => {
    const html = renderToStaticMarkup(<SettingsSave dirty onSave={noop} state="saved" />);
    expect(html).toMatch(/<button[^>]*>(<span[^>]*>)?Save(<\/span>)?<\/button>/);
    expect(html.indexOf('</button>')).toBeLessThan(html.indexOf('✓ Saved'));
    expect(renderToStaticMarkup(<SettingsSave dirty onSave={noop} label="Save contact" />)).toMatch(/>Save contact(<\/span>)?<\/button>/);
    expect(renderToStaticMarkup(<SettingsSave dirty onSave={noop} type="submit" />)).toContain('type="submit"');
  });
});

describe('SettingsGroup', () => {
  it('a group can carry an anchor', () => {
    expect(renderToStaticMarkup(<SettingsGroup id="integrations" title="Integrations" />)).toMatch(/^<section id="integrations"/);
  });
});
