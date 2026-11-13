/**
 * The header's search is the only search (owner, 2026-11-03: "it feels dumb
 * to have two searches"). On a list page that used to carry its own search
 * field, the search dialog offers that list first ("In albums"): picking it
 * narrows the page's own list to the words typed, and the list shows them
 * as a chip. Then the library-wide results follow.
 */
export interface PageSearchScope {
  /** the result group's heading */
  label: string;
  /** the list page the words narrow */
  path: '/albums' | '/artists';
}

const SCOPES: PageSearchScope[] = [
  { label: 'In albums', path: '/albums' },
  { label: 'In artists', path: '/artists' },
];

/** The list the search narrows on this page, or null (a page with no list of its own). */
export function pageSearchScope(pathname: string): PageSearchScope | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  return SCOPES.find((s) => s.path === path) ?? null;
}
