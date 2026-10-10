/**
 * Album grid filter keys with no zod attached: the web app's router reads
 * them on every page, and importing them from views.ts pulled the zod
 * schemas (55 KB) into the app's first chunk.
 */

/** Filters that accept several values at once (the rail renders them as checkboxes). */
export const MULTI_FILTER_KEYS = ['state', 'genre', 'decade', 'format', 'label', 'gap'] as const;
export type MultiFilterKey = typeof MULTI_FILTER_KEYS[number];
