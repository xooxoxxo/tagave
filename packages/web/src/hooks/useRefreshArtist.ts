/**
 * Hook for manual refresh of artist's discography from MusicBrainz (XO-348)
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';

export interface RefreshArtistResponse {
  discographyUpdated: boolean;
}

/**
 * Refresh an artist's discography from MusicBrainz (mutation)
 */
export function useRefreshArtist(libraryId: string | undefined, artistId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.post<RefreshArtistResponse>(
        `/libraries/${libraryId}/artists/${artistId}/refresh`,
        {}
      ),
    onSuccess: () => {
      // Invalidate the artist query to trigger a refetch
      queryClient.invalidateQueries({ queryKey: ['artist', libraryId, artistId] });
    },
  });
}
