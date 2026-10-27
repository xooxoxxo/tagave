/**
 * Listen elsewhere (the listen-links module): which platform a URL is, the
 * resolver that finds an album's and an artist's links, and the links a
 * person sees. The resolve job (worker) and the routes (api) use it.
 */
import { LISTEN_PLATFORM_NAMES, listenSearchUrl, type ListenLinkView, type ListenPlatform } from '@tagave/shared';

export * from './urls.js';
export * from './resolve.js';

/** Found links are looked up again after 30 days, albums and artists with nothing found after 14. */
export const LISTEN_RECHECK_FOUND_DAYS = 30;
export const LISTEN_RECHECK_MISS_DAYS = 14;

/** Whether a lookup is due again: never done, done without one of the platforms wanted now, or old. */
export function listenCheckDue(check: { checkedAt: Date | string; found: number; platforms?: readonly string[] } | null | undefined, wanted: readonly string[] = [], now = Date.now()): boolean {
  if (!check) return true;
  if (check.platforms && wanted.some((p) => !check.platforms!.includes(p))) return true;
  const days = check.found > 0 ? LISTEN_RECHECK_FOUND_DAYS : LISTEN_RECHECK_MISS_DAYS;
  return new Date(check.checkedAt).getTime() < now - days * 86_400_000;
}

/**
 * The person's links for one album, in the order they picked the platforms:
 * the album's own page, else the artist's page, else a search.
 */
export function composeListenLinks(input: {
  platforms: readonly ListenPlatform[];
  album: ReadonlyMap<string, string>;
  artist: ReadonlyMap<string, string>;
  /** "<artist> <album>" for the search */
  query: string;
}): ListenLinkView[] {
  return input.platforms.map((platform) => {
    const exact = input.album.get(platform);
    if (exact) return { platform, name: LISTEN_PLATFORM_NAMES[platform], url: exact, kind: 'exact' as const };
    const page = input.artist.get(platform);
    if (page) return { platform, name: LISTEN_PLATFORM_NAMES[platform], url: page, kind: 'artist' as const };
    return { platform, name: LISTEN_PLATFORM_NAMES[platform], url: listenSearchUrl(platform, input.query), kind: 'search' as const };
  });
}
