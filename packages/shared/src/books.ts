/**
 * The books app (platform step 3, the spike; behind TAGAVE_DEV_APPS): the
 * read-only Books page and its Settings › Modules row. api › routes/books.ts
 * answers with these; without the flag every books route answers 404.
 */
import { z } from 'zod';

/** One work on the Books page: what its editions say, the cover of the first that has one. */
export interface BookWorkView {
  id: string;
  title: string;
  /** in order */
  authors: string[];
  series: string | null;
  seriesIndex: number | null;
  /** epub, pdf, cbz: the formats its present files are in */
  formats: string[];
  /** the edition whose cover the page shows (GET /books/editions/:id/cover), or null */
  coverEditionId: string | null;
}

export interface BooksView {
  works: BookWorkView[];
}

/** Settings › Modules: the Books row. */
export interface BooksModuleView {
  enabled: boolean;
  /** the books library (made when the app is first turned on), or null before that */
  libraryId: string | null;
  folders: number;
  works: number;
  files: number;
}

export const booksModuleSchema = z.object({ enabled: z.boolean() }).strict();
