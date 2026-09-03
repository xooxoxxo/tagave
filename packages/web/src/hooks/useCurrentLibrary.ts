/**
 * Current library selection state management using zustand
 * In v1 there is one library per user, but this abstracts the pattern for P2 multi-library support
 */

import { create } from 'zustand';
import { useMe } from './useAuth';

interface CurrentLibraryStore {
  libraryId: string | null;
  setLibraryId: (id: string) => void;
}

const useCurrentLibraryStore = create<CurrentLibraryStore>((set) => ({
  libraryId: null,
  setLibraryId: (id: string) => set({ libraryId: id }),
}));

/**
 * Get the current library ID, auto-populating from the user's first (only) library
 */
export function useCurrentLibrary() {
  const { data: user, isLoading: userLoading } = useMe();
  const { data: libraries, isLoading: librariesLoading } = useLibraries();
  const libraryId = useCurrentLibraryStore((state) => state.libraryId);
  const setLibraryId = useCurrentLibraryStore((state) => state.setLibraryId);

  // Auto-set from first available library if not already set
  if (user && !libraryId && libraries && libraries.length > 0) {
    setLibraryId(libraries[0].id);
  }

  return {
    libraryId: libraryId || undefined,
    isLoading: userLoading || librariesLoading,
  };
}
