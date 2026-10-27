/**
 * Current library selection - in v1 there is one music library per user
 */

import { useMe } from './useAuth';
import { useLibraries } from './useLibrary';

/**
 * Get the current library ID: the first music library (one app per library;
 * a books library, the spike's, is never the current one). A library without
 * an app (an older server) is music.
 */
export function useCurrentLibrary() {
  const { data: user, isLoading: userLoading } = useMe();
  const { data: libraries, isLoading: librariesLoading } = useLibraries();

  const libraryId = libraries?.find((l) => (l.app ?? 'music') === 'music')?.id;

  return {
    libraryId: libraryId || undefined,
    isLoading: userLoading || librariesLoading,
  };
}
