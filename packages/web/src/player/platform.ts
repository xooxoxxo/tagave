/** iPhone, iPod, iPad, and an iPad that reports itself as a Mac. */
export function isAppleMobile(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  return /iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}

/**
 * tagave opened from the home screen of an iPhone or iPad (standalone
 * display mode): a running Web Audio graph there stops the music when the
 * app goes to the background, so the DJ module is not offered.
 */
export function isIosHomeScreenApp(
  nav: (Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> & { standalone?: boolean }) | undefined = globalThis.navigator,
  matches: ((query: string) => boolean) | undefined = (q) => { try { return globalThis.matchMedia?.(q).matches ?? false; } catch { return false; } },
): boolean {
  if (!nav || !isAppleMobile(nav)) return false;
  return nav.standalone === true || !!matches?.('(display-mode: standalone)') || !!matches?.('(display-mode: fullscreen)');
}
