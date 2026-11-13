/**
 * Registers the service worker (sw/sw.js, written to dist/sw.js by the
 * build): with public/manifest.webmanifest it makes tagave installable on a
 * phone's home screen, and it keeps the app shell for a fast start. Built
 * bundles only (vite dev has no sw.js), and only where the browser offers
 * service workers: HTTPS or localhost. Over plain http on a LAN there is
 * none; the app works the same, it just cannot be installed on Android.
 *
 * Updates need nothing from here: the worker answers page loads from the
 * network first, so a reload after an update (buildCheck.ts, quietReload.ts)
 * gets the new build, and the browser picks up the new sw.js on that load.
 */
export function registerServiceWorker({
  enabled = import.meta.env.PROD,
  container = globalThis.navigator?.serviceWorker,
}: { enabled?: boolean; container?: ServiceWorkerContainer | undefined } = {}): boolean {
  if (!enabled || !container || typeof container.register !== 'function') return false;
  const register = () => { container.register('/sw.js', { scope: '/' }).catch(() => undefined); };
  // after the first screen is up, so registering never competes with it
  if (globalThis.document?.readyState === 'complete') register();
  else globalThis.addEventListener?.('load', register, { once: true });
  return true;
}
