/** iPhone, iPod, iPad, and an iPad that reports itself as a Mac. */
export function isAppleMobile(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  return /iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}
