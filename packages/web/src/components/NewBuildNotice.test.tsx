/**
 * The "tagave was updated." note: what it says and offers, and that it
 * appears only for a newer build.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewBuildNotice, NewBuildNoticeView } from './NewBuildNotice';
import { checkForNewBuild, resetBuildCheckForTests } from '../services/buildCheck';

describe('NewBuildNoticeView', () => {
  it('says the app was updated and offers Reload and Dismiss, politely', () => {
    const html = renderToStaticMarkup(<NewBuildNoticeView onReload={() => undefined} onDismiss={() => undefined} />);
    expect(html).toContain('tagave was updated.');
    expect(html).toMatch(/<button[^>]*>.*Reload.*<\/button>/);
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});

describe('NewBuildNotice', () => {
  afterEach(() => {
    resetBuildCheckForTests({ sha: 'dev', version: null });
    vi.unstubAllGlobals();
  });

  it('renders nothing while the server runs this build', () => {
    expect(renderToStaticMarkup(<NewBuildNotice />)).toBe('');
  });

  it('shows once a newer build was found', async () => {
    resetBuildCheckForTests({ sha: 'a4c7662', version: '0.7.6' });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ sha: 'b5d8773', version: '0.7.7' })));
    await checkForNewBuild();
    expect(renderToStaticMarkup(<NewBuildNotice />)).toContain('tagave was updated.');
  });

  it('stays away for a dev bundle whatever the server runs', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ sha: 'b5d8773', version: '0.7.7' })));
    await checkForNewBuild();
    expect(renderToStaticMarkup(<NewBuildNotice />)).toBe('');
  });
});
