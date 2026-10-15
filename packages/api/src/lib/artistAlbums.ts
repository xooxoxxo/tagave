/**
 * The artist page's albums: what the library holds of an artist, and what a
 * followed artist is missing.
 *
 * In the library:
 *  - every local album of a release group the artist is credited on;
 *  - every local album known only by its tags (no release group, or one with
 *    no credits) whose album artist is this artist's name, compared as the
 *    artists list compares it (tagave_display_artist, case-insensitive) —
 *    so an artist whose albums were matched by tags alone lists them too;
 *  - release groups held only on the shelf (collection items).
 * Not in the library: release groups with a missing_album gap (open, on the
 * task list, or dismissed), which exist only for followed artists.
 *
 * Each arm is an index lookup: idx_rga_artist → idx_local_albums_release_group_id,
 * and idx_local_albums_display_artist_lower (0040) for the tag arm.
 */
import { sql } from 'drizzle-orm';

type Db = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export type ArtistAlbumOwnership = 'digital' | 'physical' | 'both' | 'missing' | 'ignored';

export interface ArtistAlbum {
  /** the local album id, or "rg:<release group id>" for a release group not on disk */
  key: string;
  localAlbumId: string | null;
  releaseGroupId: string | null;
  title: string;
  year: number | null;
  /** MusicBrainz primary type of the release group (Album, EP, …); null when unknown */
  primaryType: string | null;
  ownership: ArtistAlbumOwnership;
  /** tracks on disk (local albums only) */
  trackCount: number | null;
  coverUrl: string | null;
  /** how the album is tied to the artist */
  matchedBy: 'credit' | 'tags' | 'gap' | 'shelf';
  gapId?: string;
  dismissReason?: string | null;
  firstSeenAt?: string | null;
}

export interface ArtistAlbums {
  albums: ArtistAlbum[];
  /** what "Owned" says: albums in the library (on disk or the shelf) and their tracks on disk */
  owned: { albums: number; tracks: number };
}

/** The year of a date column, whether the client hands it over as text or as a Date. */
const yearOf = (date: string | Date | null | undefined): number | null => {
  if (!date) return null;
  const y = date instanceof Date ? date.getUTCFullYear() : parseInt(String(date).slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 ? y : null;
};

export async function fetchArtistAlbums(db: Db, libraryId: string, artist: { id: string; name: string }): Promise<ArtistAlbums> {
  const live = sql`ci.removed_at is null and ci.push_state is distinct from 'removing'`;
  const [localRows, rgRows] = await Promise.all([
    db.execute(sql`
      with credited as (
        select distinct release_group_id from release_group_artists where artist_id = ${artist.id}
      ),
      mine as (
        select la.id, 'credit'::text as matched_by
          from local_albums la
         where la.library_id = ${libraryId}
           and la.release_group_id in (select release_group_id from credited)
        union
        select la.id, 'tags'::text
          from local_albums la
         where la.library_id = ${libraryId}
           and lower(tagave_display_artist(la.artist_guess)) = lower(${artist.name})
           and (la.release_group_id is null or not exists (
             select 1 from release_group_artists rga where rga.release_group_id = la.release_group_id))
      )
      select la.id,
             la.release_group_id,
             coalesce(rg.title, la.title_guess) as title,
             rg.first_release_date,
             rg.primary_type,
             la.year_guess,
             la.track_count,
             m.matched_by,
             exists (select 1 from images im where im.local_album_id = la.id and im.kind = 'front') as has_cover,
             la.release_group_id is not null and exists (
               select 1 from collection_items ci
                where ci.release_group_id = la.release_group_id and ci.library_id = ${libraryId} and ${live}) as has_physical
        from mine m
        join local_albums la on la.id = m.id
        left join release_groups rg on rg.id = la.release_group_id
    `),
    // credited release groups with nothing on disk: on the shelf, or a gap
    db.execute(sql`
      select rg.id as release_group_id,
             rg.title,
             rg.first_release_date,
             rg.primary_type,
             exists (select 1 from collection_items ci
                      where ci.release_group_id = rg.id and ci.library_id = ${libraryId} and ${live}) as has_physical,
             g.id as gap_id,
             g.state as gap_state,
             g.dismiss_reason,
             g.first_seen_at
        from (select distinct release_group_id from release_group_artists where artist_id = ${artist.id}) c
        join release_groups rg on rg.id = c.release_group_id
        left join gaps g on g.library_id = ${libraryId}
                         and g.subject_id = rg.id
                         and g.kind = 'missing_album'
                         and g.state in ('open', 'todo', 'dismissed')
       where not exists (select 1 from local_albums la where la.release_group_id = rg.id and la.library_id = ${libraryId})
         and (g.id is not null or exists (
               select 1 from collection_items ci
                where ci.release_group_id = rg.id and ci.library_id = ${libraryId} and ${live}))
    `),
  ]);

  const albums: ArtistAlbum[] = [];
  let tracks = 0;
  for (const r of localRows as Array<{
    id: string; release_group_id: string | null; title: string | null; first_release_date: string | Date | null;
    primary_type: string | null; year_guess: number | null; track_count: number | null; matched_by: 'credit' | 'tags';
    has_cover: boolean; has_physical: boolean;
  }>) {
    const trackCount = r.track_count === null ? null : Number(r.track_count);
    tracks += trackCount ?? 0;
    albums.push({
      key: r.id,
      localAlbumId: r.id,
      releaseGroupId: r.release_group_id,
      title: r.title ?? 'Untitled',
      year: yearOf(r.first_release_date) ?? (r.year_guess ?? null),
      primaryType: r.primary_type,
      ownership: r.has_physical ? 'both' : 'digital',
      trackCount,
      coverUrl: r.has_cover ? `/api/v1/images/album/${r.id}` : null,
      matchedBy: r.matched_by,
    });
  }
  for (const r of rgRows as Array<{
    release_group_id: string; title: string; first_release_date: string | Date | null; primary_type: string | null;
    has_physical: boolean; gap_id: string | null; gap_state: string | null; dismiss_reason: string | null;
    first_seen_at: string | Date | null;
  }>) {
    // dismissed wins: the owner chose to skip it; otherwise on the shelf or missing
    const ownership: ArtistAlbumOwnership = r.gap_state === 'dismissed' ? 'ignored' : r.has_physical ? 'physical' : 'missing';
    albums.push({
      key: `rg:${r.release_group_id}`,
      localAlbumId: null,
      releaseGroupId: r.release_group_id,
      title: r.title,
      year: yearOf(r.first_release_date),
      primaryType: r.primary_type,
      ownership,
      trackCount: null,
      coverUrl: null,
      matchedBy: r.has_physical && ownership === 'physical' ? 'shelf' : 'gap',
      ...(r.gap_id && {
        gapId: r.gap_id,
        dismissReason: r.dismiss_reason,
        // raw timestamps come back as strings on the shared client
        firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at).toISOString() : null,
      }),
    });
  }
  // oldest first; undated last; then by title so the order is stable
  albums.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
  const ownedCount = albums.filter((a) => a.ownership !== 'missing' && a.ownership !== 'ignored').length;
  return { albums, owned: { albums: ownedCount, tracks } };
}
