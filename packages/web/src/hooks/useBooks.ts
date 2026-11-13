/**
 * The books app (the spike, behind TAGAVE_DEV_APPS; api › routes/books.ts):
 * the works for the Books page and its Settings › Modules switch. Off, or a
 * server without the flag: nothing is asked for and nothing shows.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BooksModuleView, BooksView } from '@tagave/shared';
import { api } from '../services/api';
import { facetsKey, useAppOn, useDevAppAllowed } from './useFacets';
import { useCan } from './usePermissions';

export const booksKey = ['books'] as const;
export const booksModuleKey = ['books-module'] as const;

/** The 300 px cover of an edition (JPEG). */
export const bookCoverUrl = (editionId: string) => `/api/v1/books/editions/${encodeURIComponent(editionId)}/cover`;

/** The books app can be used here: it is on and the person may read the catalogue. */
export function useBooksOn(): boolean {
  const on = useAppOn('books');
  const canRead = useCan('catalog.read');
  return on === true && canRead;
}

export function useBooks() {
  const on = useBooksOn();
  return useQuery({
    queryKey: booksKey,
    queryFn: async () => (await api.get<BooksView>('/books')).works,
    enabled: on,
    staleTime: 30_000,
    retry: false,
  });
}

/* ---------- Settings › Modules › Books (only with the flag) ---------- */

export function useBooksModule() {
  // asked for only when the server names books in TAGAVE_DEV_APPS: an install without the flag sends nothing
  const allowed = useDevAppAllowed('books') === true;
  return useQuery({ queryKey: booksModuleKey, queryFn: () => api.get<BooksModuleView>('/settings/books'), enabled: allowed, retry: false });
}

export function useSetBooksModule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.put<BooksModuleView>('/settings/books', { enabled }),
    onSuccess: (view) => {
      client.setQueryData(booksModuleKey, view);
      for (const key of [facetsKey, booksKey, ['libraries']]) void client.invalidateQueries({ queryKey: key });
    },
  });
}
