/**
 * Similar artists (the similar-artists module; api › routes/similarArtists.ts):
 * the artist page's section, Follow for an artist the library has no row
 * for, an artist's mix for Play, and the Settings › Modules row. While the
 * first fetch is on its way the section is asked for again every few
 * seconds, a few times.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ArtistSimilarView, SimilarArtistsModuleView } from '@tagave/shared';
import { api } from '../services/api';
import { facetsKey, useModuleOn } from './useFacets';

export const similarModuleKey = ['similar-module'] as const;
const similarKey = ['similar-artists'] as const;

const POLL_MS = 3000;
const POLLS = 8;

export function useArtistSimilar(libraryId: string | undefined, artistId: string | undefined) {
  const on = useModuleOn('similar-artists');
  return useQuery({
    queryKey: [...similarKey, libraryId, artistId],
    queryFn: () => api.get<ArtistSimilarView>(`/libraries/${libraryId}/artists/${artistId}/similar`),
    enabled: on === true && !!libraryId && !!artistId,
    retry: false,
    staleTime: 60_000,
    refetchInterval: (q) => (q.state.data?.pending && q.state.dataUpdateCount <= POLLS ? POLL_MS : false),
  });
}

/** Follow a similar artist: by its tagave row when it has one, else by MBID (the API makes the row). */
export function useFollowSimilar(libraryId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (a: { artistId: string | null; mbid: string | null; name: string }) => (a.artistId
      ? api.post<{ followed: boolean }>(`/libraries/${libraryId}/artists/${a.artistId}/follow`, { followed: true })
      : api.post<{ artistId: string; followed: true }>(`/libraries/${libraryId}/similar-artists/follow`, { mbid: a.mbid, name: a.name })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: similarKey });
      void client.invalidateQueries({ queryKey: ['artist', libraryId] });
    },
  });
}

/** Up to 100 of an artist's tracks in the library, shuffled: Play on a similar artist's card. */
export function fetchArtistMix(libraryId: string, artistId: string): Promise<{ name: string; trackIds: string[] }> {
  return api.get<{ name: string; trackIds: string[] }>(`/libraries/${libraryId}/artists/${artistId}/mix`);
}

/* ---------- Settings › Modules › Similar artists ---------- */

export function useSimilarArtistsModule(enabled = true) {
  return useQuery({ queryKey: similarModuleKey, queryFn: () => api.get<SimilarArtistsModuleView>('/settings/similar-artists'), enabled, retry: false });
}

function useAfter() {
  const client = useQueryClient();
  return (view: SimilarArtistsModuleView) => {
    client.setQueryData(similarModuleKey, view);
    for (const key of [facetsKey, similarKey]) void client.invalidateQueries({ queryKey: key });
  };
}

export function useSetSimilarArtistsModule() {
  const after = useAfter();
  return useMutation({ mutationFn: (enabled: boolean) => api.put<SimilarArtistsModuleView>('/settings/similar-artists', { enabled }), onSuccess: after });
}

export function useRemoveSimilarArtistsData() {
  const after = useAfter();
  return useMutation({ mutationFn: () => api.post<SimilarArtistsModuleView>('/settings/similar-artists/remove-data', {}), onSuccess: after });
}
