/**
 * Current library selection - in v1 there is one library per user
 */

import { useMe } from './useAuth';
import { useLibraries } from './useLibrary';

/**
 * Get the current library ID (auto-selected as the first available library since v1 has only one per user)
 */
export function useCurrentLibrary() {
  const { data: user, isLoading: userLoading } = useMe();
  const { data: libraries, isLoading: librariesLoading } = useLibraries();

  // In v1, return the first (only) library ID when available
  const libraryId = libraries?.[0]?.id;

  return {
    libraryId: libraryId || undefined,
    isLoading: userLoading || librariesLoading,
  };
}
