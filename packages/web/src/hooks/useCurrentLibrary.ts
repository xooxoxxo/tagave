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
  const libraryId = useCurrentLibraryStore((state) => state.libraryId);
  const setLibraryId = useCurrentLibraryStore((state) => state.setLibraryId);

  // Auto-set from user data if available and not already set
  if (user && !libraryId && 'defaultLibraryId' in user) {
    const userId = (user as any).defaultLibraryId;
    if (userId) setLibraryId(userId);
  }

  return {
    libraryId: libraryId || undefined,
    isLoading: userLoading,
  };
}
