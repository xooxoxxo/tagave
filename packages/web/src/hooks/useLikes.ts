/**
 * Likes (api › routes/likes.ts): what the person liked, as sets the hearts
 * test; a toggle that shows at once and goes back if the server says no;
 * Liked songs.
 */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LikeKeysView, LikeKind, LikedSongsView } from '@tagave/shared';
import { api } from '../services/api';
import { showToast } from '../components/ui/Toast';
import { useCan } from './usePermissions';

export const likesKey = ['likes'] as const;
export const likedSongsKey = ['likes', 'songs'] as const;

export interface LikeSets {
  songs: ReadonlySet<string>;
  albums: ReadonlySet<string>;
  artists: ReadonlySet<string>;
}

const EMPTY: LikeKeysView = { songs: [], albums: [], artists: [] };
const field = (kind: LikeKind): keyof LikeKeysView => (kind === 'song' ? 'songs' : kind === 'album' ? 'albums' : 'artists');

/** Likes can be used here: the person may read the catalogue. */
export function useLikesOn(): boolean {
  return useCan('catalog.read');
}

export function useLikeKeys() {
  const on = useLikesOn();
  return useQuery({
    queryKey: likesKey,
    queryFn: () => api.get<LikeKeysView>('/me/likes'),
    enabled: on,
    staleTime: 60_000,
    retry: false,
  });
}

/** The liked ids as sets (empty while loading). */
export function useLikeSets(): LikeSets {
  const { data } = useLikeKeys();
  return useMemo(() => {
    const d = data ?? EMPTY;
    return { songs: new Set(d.songs), albums: new Set(d.albums), artists: new Set(d.artists) };
  }, [data]);
}

export function useLiked(kind: LikeKind, id: string | null | undefined): boolean {
  const sets = useLikeSets();
  return !!id && sets[field(kind)].has(id);
}

/** The keys with one id put in or taken out (what the server will answer, shown before it does). */
export function toggledKeys(keys: LikeKeysView, kind: LikeKind, id: string, like: boolean): LikeKeysView {
  const k = field(kind);
  const rest = keys[k].filter((x) => x !== id);
  return { ...keys, [k]: like ? [...rest, id] : rest };
}

/** Like or unlike: the heart changes at once; on an error it goes back and a toast says so. */
export function useToggleLike() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id, like }: { kind: LikeKind; id: string; like: boolean }) =>
      like ? api.put<LikeKeysView>(`/me/likes/${kind}/${encodeURIComponent(id)}`) : api.delete<LikeKeysView>(`/me/likes/${kind}/${encodeURIComponent(id)}`),
    onMutate: async ({ kind, id, like }) => {
      await client.cancelQueries({ queryKey: likesKey, exact: true });
      const before = client.getQueryData<LikeKeysView>(likesKey);
      client.setQueryData<LikeKeysView>(likesKey, toggledKeys(before ?? EMPTY, kind, id, like));
      if (!like && kind === 'song') {
        client.setQueryData<LikedSongsView>(likedSongsKey, (v) => (v ? { ...v, count: Math.max(0, v.count - 1), items: v.items.filter((i) => i.localTrackId !== id && i.id !== id) } : v));
      }
      return { before };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.before) client.setQueryData(likesKey, ctx.before);
      else void client.invalidateQueries({ queryKey: likesKey, exact: true });
      void client.invalidateQueries({ queryKey: likedSongsKey });
      showToast({ message: 'Not saved. Try again.', tone: 'danger' });
    },
    onSuccess: (keys, { kind }) => {
      client.setQueryData(likesKey, keys);
      if (kind === 'song') void client.invalidateQueries({ queryKey: likedSongsKey });
      // the Liked filter: its counts, and the lists filtered to liked ones
      const likedList = (q: { queryKey: readonly unknown[] }) => q.queryKey.some((k) => typeof k === 'string' && k.includes('liked=yes'));
      if (kind === 'album') {
        void client.invalidateQueries({ queryKey: ['album-facets'] });
        void client.invalidateQueries({ queryKey: ['albums', 'infinite'], predicate: likedList });
      }
      if (kind === 'artist') void client.invalidateQueries({ queryKey: ['artists-list', 'infinite'], predicate: likedList });
    },
  });
}

export function useLikedSongs() {
  const on = useLikesOn();
  return useQuery({
    queryKey: likedSongsKey,
    queryFn: () => api.get<LikedSongsView>('/me/likes/songs'),
    enabled: on,
    retry: false,
  });
}
