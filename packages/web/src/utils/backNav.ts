/**
 * The context-aware app bar: detail pages get a back button in place of the
 * mark. Back returns to where the viewer came from inside the app; opened
 * cold (a bookmark, a new tab) it goes to the page's parent list instead.
 */

/**
 * The list a detail page belongs to, or null for a top-level page. Settings
 * sections are faces of one page, not details, so they keep the mark.
 */
export function parentPath(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  const m = path.match(/^\/(albums|artists|plans)\/[^/]+(?:\/.*)?$/);
  if (!m) return null;
  return `/${m[1]}`;
}

export function isDetailPath(pathname: string): boolean {
  return parentPath(pathname) !== null;
}

/** "Albums" for the back button's accessible name. */
export function parentLabel(parent: string): string {
  const name = parent.slice(1);
  if (name === 'plans') return 'Tag changes';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export type BackAction =
  | { kind: 'history' }
  | { kind: 'navigate'; to: string };

/**
 * What the back button does on this page: step back through the app's own
 * history when there is an entry to return to, else open the parent list.
 * Null on a top-level page (the mark shows there instead).
 */
export function backAction(pathname: string, canGoBack: boolean): BackAction | null {
  const parent = parentPath(pathname);
  if (!parent) return null;
  return canGoBack ? { kind: 'history' } : { kind: 'navigate', to: parent };
}
