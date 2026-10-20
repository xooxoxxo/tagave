/**
 * The project's docs at tagave.app/docs. Pages keep setup steps out of the
 * UI and link here with one "How to" instead.
 */
const DOCS_BASE = 'https://tagave.app/docs/';

/**
 * A docs file and optional heading anchor, as named in the repo's docs/
 * folder: docsUrl('install.md#play-your-music-optional-player') →
 * https://tagave.app/docs/install/#play-your-music-optional-player
 */
export const docsUrl = (path: string): string => {
  const [file = '', anchor] = path.split('#');
  const slug = file.replace(/\.md$/, '');
  return `${DOCS_BASE}${slug}/${anchor ? `#${anchor}` : ''}`;
};
