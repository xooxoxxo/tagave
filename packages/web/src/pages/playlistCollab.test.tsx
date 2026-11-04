/**
 * Collaborative playlists (0079) and every song's menu:
 *
 *   trackMenuKeys   one order on every surface, Delete last, each where it applies
 *   showAdders      who added shows once more than one person has
 *   the page        the owner renames and has Collaborators and Delete; a
 *                   collaborator has neither, and Remove from playlist only on
 *                   what they added; the header's people, the rows' adders
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
  useNavigate: () => () => undefined,
  useRouter: () => ({ history: { back: () => undefined, length: 1 } }),
  useCanGoBack: () => false,
  useParams: () => ({}),
  useSearch: () => ({}),
  useLocation: () => ({ pathname: '/playlists/p1' }),
  useRouterState: () => ({ location: { pathname: '/playlists/p1' } }),
}));

const { trackMenuKeys } = await import('../components/player/TrackActions');
const { showAdders } = await import('../components/playlists/People');
const { PlaylistPageView } = await import('./PlaylistPage');
const { PLAYLIST, PLAYLIST_SHARED, PLAYLIST_SHARED_OWNER } = await import('../stories/queueFixtures');

const noop = () => undefined;
const all = { queue: true, playlists: true, album: true, artist: true, delete: true };

describe('trackMenuKeys: every song’s menu, one order', () => {
  it('Play next · Add to queue · Add to playlist | Go to album · Go to artist | own rows | Delete', () => {
    expect(trackMenuKeys(all, ['remove'])).toEqual([
      { key: 'next', separated: false }, { key: 'queue', separated: false }, { key: 'playlist', separated: false },
      { key: 'album', separated: true }, { key: 'artist', separated: false },
      { key: 'remove', separated: true },
      { key: 'delete', separated: true },
    ]);
  });
  it('leaves out what does not apply, and separates only between groups', () => {
    expect(trackMenuKeys({ ...all, queue: false, album: false, delete: false })).toEqual([
      { key: 'playlist', separated: false }, { key: 'artist', separated: true },
    ]);
    // a listener with no player, on the album page: nothing to do, no menu
    expect(trackMenuKeys({ queue: false, playlists: false, album: false, artist: false, delete: false })).toEqual([]);
    // the owner with no player and playlists off: Delete alone, unseparated
    expect(trackMenuKeys({ queue: false, playlists: false, album: false, artist: false, delete: true })).toEqual([{ key: 'delete', separated: false }]);
  });
});

describe('showAdders', () => {
  it('only when more than one person has added', () => {
    expect(showAdders(PLAYLIST.items)).toBe(false);
    expect(showAdders(PLAYLIST_SHARED.items)).toBe(true);
    expect(showAdders([])).toBe(false);
    // an account deleted since counts as someone else
    expect(showAdders([{ addedBy: PLAYLIST.owner }, { addedBy: null }])).toBe(true);
  });
});

function page(over: Partial<Parameters<typeof PlaylistPageView>[0]>) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PlaylistPageView
        playlist={PLAYLIST} canPlay playing={null} currentTrackId={null}
        onPlay={noop} onShuffle={noop} onToggle={noop} onRename={async () => undefined} onMove={noop} onRemove={noop} onExport={noop}
        {...over}
      />
    </QueryClientProvider>,
  );
}

describe('the playlist page, as its owner and as a collaborator', () => {
  it('a list of one person’s: no people, no adders', () => {
    const html = page({ onDelete: noop, onCollaborators: noop });
    expect(html).not.toContain('added by');
    expect(html).not.toMatch(/role="group" aria-label="Olive/);
  });
  it('shared: the header names its people; each row says who added it', () => {
    const html = page({ playlist: PLAYLIST_SHARED_OWNER, onDelete: noop, onCollaborators: noop });
    expect(html).toContain('role="group" aria-label="Olive, Anna, Ben"');
    expect(html).toContain(', added by Anna');
    expect(html).toContain(', added by Ben');
    expect((html.match(/data-size="sm"/g) ?? []).length).toBe(PLAYLIST_SHARED_OWNER.items.length);
  });
  it('a collaborator: the name is not renamable; Missing rows they did not add have no remove key', () => {
    const view = { ...PLAYLIST_SHARED, mine: false };
    const html = page({ playlist: view });
    expect(html).not.toContain('Rename playlist');
    // Gone Soon (Missing) was Olive's: Anna cannot take it out
    expect(html).not.toContain('aria-label="Remove Gone Soon"');
    const own = page({ playlist: { ...view, items: view.items.map((i) => (i.localTrackId ? i : { ...i, removable: true })) } });
    expect(own).toContain('aria-label="Remove Gone Soon"');
  });
  it('its owner renames in place', () => {
    expect(page({ playlist: PLAYLIST_SHARED_OWNER, onDelete: noop })).toContain('Rename playlist');
  });
});
