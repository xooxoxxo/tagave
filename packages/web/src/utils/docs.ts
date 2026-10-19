/**
 * The project's docs on GitHub. Pages keep setup steps out of the UI and
 * link here with one "How to" instead.
 */
const DOCS_BASE = 'https://github.com/xooxoxxo/tagave/blob/main/docs/';

/** e.g. docsUrl('install.md#play-your-music-optional-player') */
export const docsUrl = (path: string): string => DOCS_BASE + path;
