import { useSyncExternalStore } from 'react';

/** Whether a media query matches now, following changes (false where there is no matchMedia). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = globalThis.matchMedia?.(query);
      m?.addEventListener?.('change', onChange);
      return () => m?.removeEventListener?.('change', onChange);
    },
    () => globalThis.matchMedia?.(query).matches ?? false,
    () => false,
  );
}

/** The phone layout (the app's own breakpoint, Layout.module.css). */
export const PHONE_QUERY = '(max-width: 720px)';
