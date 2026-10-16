/**
 * A Music Connections consent page opened while signed out: the request is
 * remembered for this tab (for as long as the request itself lives), and
 * signing in comes back to it instead of Home. The consent page forgets it.
 */
const KEY = 'tagave-connect-request';
const REQUEST_RE = /^mcq_[A-Za-z0-9_-]{43}$/;
/** The api's REQUEST_TTL_S. */
const KEEP_MS = 10 * 60 * 1000;

export function isConsentRequestId(id: unknown): id is string {
  return typeof id === 'string' && REQUEST_RE.test(id);
}

export function rememberConsentRequest(id: unknown, now = Date.now()): void {
  if (!isConsentRequestId(id)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ id, at: now }));
  } catch {
    /* storage blocked: sign-in lands on Home */
  }
}

/** The remembered request id, if any (still remembered after reading). */
export function rememberedConsentRequest(now = Date.now()): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const { id, at } = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (isConsentRequestId(id) && typeof at === 'number' && now - at < KEEP_MS) return id;
    sessionStorage.removeItem(KEY);
    return null;
  } catch {
    return null;
  }
}

export function forgetConsentRequest(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}

type SignInTarget = { to: '/connect/consent'; search: { request: string } } | { to: '/' };

/** Where a finished sign-in goes: the remembered consent page, else Home. */
export function signInTarget(now = Date.now()): SignInTarget {
  const request = rememberedConsentRequest(now);
  return request ? { to: '/connect/consent', search: { request } } : { to: '/' };
}

export function afterSignIn(navigate: (opts: SignInTarget) => unknown): void {
  navigate(signInTarget());
}
