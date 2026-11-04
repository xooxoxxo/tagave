import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, Link, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useMe, useCurrentLibrary, useJobEvents, useLogout, useGapCounts, useCan } from '../hooks';
import { SearchModal, type SearchScope } from './SearchModal';
import { pageSearchScope } from '../utils/pageSearch';
import { IconButton } from './ui';
import { AccountCompartment, type CompartmentLink } from './AccountCompartment';
import { useMaintenance, isMaintenanceShortcut } from '../maintenance';
import { useDisplayPrefs } from '../displayPrefs';
import { MaintenancePill } from './MaintenanceToggle';
import { PageBackActionContext, PageBackContext } from './ui/PageShell';
import { backAction, parentLabel, parentPath } from '../utils/backNav';
import { trackPlaces, useEntry, useScrollPlace } from '../utils/listPlace';
import { useAppBarTitle, useSubpage } from './appBarTitle';
import { pageTitle, pageTitles } from '../utils/pageTitles';
import { BrandMark } from './BrandMark';
import { useUpdateAvailable } from '../hooks/useUpdates';
import { AlbumSelectionGuard } from './AlbumSelectionGuard';
import { useAlbumsReturnSearch } from '../pages/albumSelection';
import { PlayerBar } from './PlayerBar';
import { MenuPlaylists } from './playlists/MenuPlaylists';
import { usePlaylistsOn } from '../hooks/usePlaylists';
import { AdaptiveColour } from '../adaptive/AdaptiveColour';
import { ThemeColours } from '../themes/ThemeColours';
import { AppDownHost } from './update/UpdateDownScreen';
import { DiskSpaceNotice } from './DiskSpaceNotice';
import { MusicFolderNotice } from './MusicFolderNotice';
import { stop as stopPlayback } from '../player/engine';
import styles from './Layout.module.css';

export function Layout() {
  const { data: user } = useMe();
  const { libraryId } = useCurrentLibrary();
  const { pathname } = useLocation();
  const logout = useLogout();
  const [searchOpen, setSearchOpen] = useState(false);
  // Phone only: the links and the account live behind one menu button.
  const [menuOpen, setMenuOpen] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const router = useRouter();
  const navigate = useNavigate();
  const [maintenance, setMaintenance] = useMaintenance();
  // Settings › Appearance: search beside the logo or below it, wordmark on or off
  const [{ searchPlacement, showWordmark }] = useDisplayPrefs();
  const barTitle = useAppBarTitle();
  // A page inside a page (a Settings section on a phone): back to its list.
  const subpage = useSubpage();
  // Detail pages trade the mark for a back button (phone); on wider screens
  // the back button leads the page's title row and, once the title scrolls
  // away, a slim bar fades in over the page with both.
  const parent = parentPath(pathname);
  // What this person's role includes (Settings › Users): a listener has no
  // library care, tag changes or install settings, so none of it is asked for.
  const canCare = useCan('library.edit');
  const canSystem = useCan('system.manage');
  const playlistsOn = usePlaylistsOn();
  useJobEvents(user && libraryId && canCare ? libraryId : undefined);
  // open tasks (gaps the owner took on) show as a count on Library care
  // (inside the account compartment; a dot on its row while it is closed)
  const taskCount = useGapCounts(user && canCare ? libraryId : undefined).data?.tasks?.todo ?? 0;
  // a newer release (not skipped) shows as a quiet dot on Settings (same)
  const updateAvailable = useUpdateAvailable(user && canSystem ? libraryId : undefined);
  // While albums are selected, "Albums" leads back to that list, selection intact.
  const albumsReturnSearch = useAlbumsReturnSearch();

  // The page's scroll: back where it was on a Back (the entry's place,
  // utils/listPlace.ts), the top on a page opened afresh.
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
  const attachMain = useCallback((el: HTMLElement | null) => { main.current = el; setMainEl(el); }, []);
  useScrollPlace(mainEl, 'main', useEntry(router.history, pathname), { resetOnEnter: true });
  // a new history entry forgets the places it overwrites
  useEffect(() => trackPlaces(router.history), [router]);
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  // the phone's menu opens under the bar, to the foot: it needs the bar's height
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!menuOpen || !nav) return;
    const write = () => nav.style.setProperty('--nav-bar-h', `${nav.getBoundingClientRect().bottom}px`);
    write();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(write);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [menuOpen]);
  // the audio lives outside React: signed out (or the session ended), it stops
  useEffect(() => { if (!user) stopPlayback(); }, [user]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      // the account menu inside the sheet closes first (it takes its own Escape)
      if (e.key === 'Escape' && !e.defaultPrevented) { setMenuOpen(false); menuButton.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (canCare && isMaintenanceShortcut(e, e.target)) {
        e.preventDefault();
        setMaintenance(!maintenance);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maintenance, setMaintenance, canCare]);

  if (!user) return <Outlet />;
  const linkClass = (active: boolean) => active ? styles.navLinkActive : styles.navLink;
  const closeSearch = () => { setSearchOpen(false); searchButton.current?.focus(); };
  // a list page (Albums, Artists): the search narrows its list first
  const listScope = pageSearchScope(pathname);
  const searchScope: SearchScope | null = listScope && {
    label: listScope.label,
    kind: listScope.path === '/albums' ? 'album' : 'artist',
    onPick: (q) => void navigate({ to: listScope.path, search: ((prev: Record<string, unknown>) => ({ ...prev, q })) as never }),
  };
  const canGoBack = router.history.canGoBack();
  const back = backAction(pathname, canGoBack);
  const backLabel = back?.kind === 'navigate' && parent ? `Back to ${parentLabel(parent)}` : 'Back';
  const goBack = () => {
    if (!back) return;
    if (back.kind === 'history') router.history.back();
    else void navigate({ to: back.to, ...(back.to === '/albums' && albumsReturnSearch ? { search: albumsReturnSearch as never } : {}) });
  };
  const backChevron = <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>;
  const backButton = back && (
    <IconButton label={backLabel} variant="quiet" className={styles.backButton} onClick={goBack}>
      {backChevron}
    </IconButton>
  );
  const shownTitle = back && barTitle.title ? barTitle.title : null;
  // Phone: the bar names the page in place of the wordmark.
  const title = pageTitle(pathname);
  const upButton = !back && subpage && (
    <IconButton label={`Back to ${pageTitle(subpage.up) ?? 'the list'}`} variant="quiet" className={styles.backButton} onClick={() => void navigate({ to: subpage.up })}>
      {backChevron}
    </IconButton>
  );
  // Maintenance changes the album and artist pages, so its key lives in
  // their own header; elsewhere a pill says it is on.
  const onAlbumPage = /^\/(albums|artists)\/[^/]+/.test(pathname);
  // Looking after the library lives with the account, under the person
  // (owner, 2026-10-28); the sidebar keeps the places to browse.
  const careLinks: CompartmentLink[] = [
    { key: 'settings', label: pageTitles['/settings'], current: pathname.startsWith('/settings') || pathname.startsWith('/jobs'), onSelect: () => void navigate({ to: '/settings' }), ...(updateAvailable ? { dot: 'a new version is available' } : {}) },
    ...(canCare ? [
      { key: 'work', label: pageTitles['/work'], current: ['/work', '/queue', '/identify', '/attention'].some((p) => pathname.startsWith(p)), onSelect: () => void navigate({ to: '/work', search: { tab: 'review' } }), count: taskCount, countLabel: `open ${taskCount === 1 ? 'task' : 'tasks'}` },
      { key: 'plans', label: pageTitles['/plans'], current: pathname.startsWith('/plans'), onSelect: () => void navigate({ to: '/plans' }) },
    ] : []),
  ];
  const backAct = back ? { label: backLabel, go: goBack } : null;
  const renderInlineBack = () => back && (
    <IconButton label={backLabel} variant="quiet" className={styles.inlineBack} onClick={goBack}>
      {backChevron}
    </IconButton>
  );

  return (
    <div className={styles.container}>
      <a href="#main-content" className={styles.skipLink}>Skip to content</a>
      <aside ref={navRef} className={`${styles.nav} ${menuOpen ? styles.navOpen : ''} ${back || upButton ? styles.navDetail : ''}`}>
        {back && (
          <div className={styles.phoneBar}>
            {backButton}
            <span className={`${styles.barTitle} ${barTitle.shown ? styles.barTitleShown : ''}`} aria-hidden={!barTitle.shown}>{shownTitle}</span>
          </div>
        )}
        {upButton && (
          <div className={styles.phoneBar}>
            {upButton}
            <span className={`${styles.barTitle} ${styles.barTitleShown}`} aria-hidden="true">{subpage.title}</span>
          </div>
        )}
        <div className={searchPlacement === 'beside' ? styles.brandRowBeside : styles.brandRow}>
        <Link to="/" className={styles.brand} aria-label="tagave">
          <BrandMark className={styles.brandMark} />
          {showWordmark && <span className={styles.wordmark}>tagave</span>}
        </Link>
        {/* the page's own heading names it for a screen reader */}
        {title && <span className={styles.pageTitle} aria-hidden="true">{title}</span>}
        <div className={styles.tools}>
        <button ref={searchButton} className={styles.searchButton} onClick={() => setSearchOpen(true)} aria-haspopup="dialog" aria-label="Search your library">
          <svg className={styles.searchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <span className={styles.searchLabel}>Search</span> <kbd>⌘ K</kbd>
        </button>
        </div>
        </div>
        {onAlbumPage ? null : <MaintenancePill className={styles.modePill} />}
        <button
          ref={menuButton}
          type="button"
          className={styles.menuButton}
          aria-expanded={menuOpen}
          aria-controls="main-navigation"
          aria-label={menuOpen ? 'Close menu' : updateAvailable ? 'Open menu (a new version is available)' : 'Open menu'}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            {menuOpen ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
          {updateAvailable && !menuOpen && <span className={styles.menuDot} aria-hidden="true" />}
        </button>
        <div id="main-navigation" className={styles.navSheet}>
        <nav className={styles.navLinks} aria-label="Main navigation">
          <Link to="/" className={linkClass(pathname === '/')}>{pageTitles['/']}</Link>
          <Link to="/albums" search={albumsReturnSearch as never} className={linkClass(pathname.startsWith('/albums'))}>{pageTitles['/albums']}</Link>
          <Link to="/artists" className={linkClass(pathname.startsWith('/artists'))}>{pageTitles['/artists']}</Link>
          <Link to="/collection" className={linkClass(pathname.startsWith('/collection'))}>{pageTitles['/collection']}</Link>
          {playlistsOn && <Link to="/playlists" className={`${linkClass(pathname.startsWith('/playlists'))} ${styles.wideOnly}`}>{pageTitles['/playlists']}</Link>}
        </nav>
        {/* phone: the person's playlists under the links (wider screens: the Playlists link) */}
        <MenuPlaylists activeId={pathname.startsWith('/playlists/') ? pathname.split('/')[2] : null} />
        {/* the signed-in person: a band on the bottom edge that opens a compartment above it */}
        <div className={styles.account} data-account-row="">
          {logout.isError && <p role="alert" className={styles.accountError}>Could not sign out. Please try again.</p>}
          <AccountCompartment
            name={user.displayName}
            email={user.email}
            signingOut={logout.isPending}
            closeKey={pathname}
            onAccount={() => void navigate({ to: '/settings/$section', params: { section: 'account' } })}
            onListening={() => void navigate({ to: '/settings/modules/$module', params: { module: 'player' } })}
            links={careLinks}
            onSignOut={() => { stopPlayback(); logout.mutate(); }}
          />
        </div>
        </div>
      </aside>
      <div className={styles.contentArea}>
        {/* The footer scrolls with the page instead of holding a strip of
            every screen; on a phone that strip cost a fifth of the height. */}
        <main id="main-content" ref={attachMain} tabIndex={-1} className={styles.main}>
          {/* Detail pages: the back button leads the page's title row (the
              page shell renders it); once the title scrolls away this bar
              fades in over the page with the back button and the title. */}
          {back && (
            <div className={`${styles.appBar} ${barTitle.shown ? styles.appBarScrolled : ''}`} inert={!barTitle.shown}>
              {backButton}
              <span className={`${styles.barTitle} ${barTitle.shown ? styles.barTitleShown : ''}`} aria-hidden={!barTitle.shown}>{shownTitle}</span>
            </div>
          )}
          <PageBackContext.Provider value={renderInlineBack}>
            <PageBackActionContext.Provider value={backAct}>
              {/* the owner only, while a disk tagave writes is filling up */}
              <DiskSpaceNotice />
              {/* the owner only, while a music folder's latest scan was aborted (unmounted share) */}
              <MusicFolderNotice />
              <div className={styles.page}><Outlet /></div>
            </PageBackActionContext.Provider>
          </PageBackContext.Provider>
        </main>
        {/* mounted once here, under the page: route changes never unmount the audio */}
        <PlayerBar />
        {/* the theme first: switching to Adaptive takes its tokens off before the cover's go on */}
        <ThemeColours />
        <AdaptiveColour />
      </div>
      {/* while the app is down for an update: a screen over the page, under the player */}
      <AppDownHost />
      {searchOpen && <SearchModal onClose={closeSearch} scope={searchScope} />}
      <AlbumSelectionGuard />
    </div>
  );
}
