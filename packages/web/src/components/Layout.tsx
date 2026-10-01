import { useEffect, useRef, useState } from 'react';
import { Outlet, Link, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useMe, useCurrentLibrary, useJobEvents, useLogout, useGapCounts } from '../hooks';
import { SearchModal } from './SearchModal';
import { Button, IconButton } from './ui';
import { useMaintenance, isMaintenanceShortcut } from '../maintenance';
import { backAction, parentLabel, parentPath } from '../utils/backNav';
import { useAppBarTitle } from './appBarTitle';
import { BrandMark } from './BrandMark';
import { UpdateDot } from './UpdateDot';
import { useUpdateAvailable } from '../hooks/useUpdates';
import { AlbumSelectionGuard } from './AlbumSelectionGuard';
import { useAlbumsReturnSearch } from '../pages/albumSelection';
import styles from './Layout.module.css';

export function Layout() {
  const { data: user } = useMe();
  const { libraryId } = useCurrentLibrary();
  const { pathname } = useLocation();
  const logout = useLogout();
  const [searchOpen, setSearchOpen] = useState(false);
  // Phone only: the links and sign out live behind one menu button.
  const [menuOpen, setMenuOpen] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const router = useRouter();
  const navigate = useNavigate();
  const [maintenance, setMaintenance] = useMaintenance();
  const barTitle = useAppBarTitle();
  // Detail pages trade the mark for a back button (phone) or a slim bar
  // above the page (wider screens); the page's title fades into it on scroll.
  const parent = parentPath(pathname);
  useJobEvents(user && libraryId ? libraryId : undefined);
  // open tasks (gaps the owner took on) show as a count on Library care
  const taskCount = useGapCounts(user ? libraryId : undefined).data?.tasks?.todo ?? 0;
  // a newer release (not skipped) shows as a quiet dot on Settings
  const updateAvailable = useUpdateAvailable(user ? libraryId : undefined);
  // While albums are selected, "Albums" leads back to that list, selection intact.
  const albumsReturnSearch = useAlbumsReturnSearch();

  useEffect(() => { main.current?.scrollTo(0, 0); setMenuOpen(false); }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenuOpen(false); menuButton.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isMaintenanceShortcut(e, e.target)) {
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
  }, [maintenance, setMaintenance]);

  if (!user) return <Outlet />;
  const linkClass = (active: boolean) => active ? styles.navLinkActive : styles.navLink;
  const closeSearch = () => { setSearchOpen(false); searchButton.current?.focus(); };
  const canGoBack = router.history.canGoBack();
  const back = backAction(pathname, canGoBack);
  const backLabel = back?.kind === 'navigate' && parent ? `Back to ${parentLabel(parent)}` : 'Back';
  const goBack = () => {
    if (!back) return;
    if (back.kind === 'history') router.history.back();
    else void navigate({ to: back.to, ...(back.to === '/albums' && albumsReturnSearch ? { search: albumsReturnSearch as never } : {}) });
  };
  const backButton = back && (
    <IconButton label={backLabel} variant="quiet" className={styles.backButton} onClick={goBack}>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>
    </IconButton>
  );
  const shownTitle = back && barTitle.title ? barTitle.title : null;
  const maintenanceToggle = (
    <IconButton
      label={maintenance ? 'Turn off Maintenance' : 'Turn on Maintenance'}
      title={maintenance ? 'Maintenance is on: curation tools are showing (Shift+M)' : 'Maintenance: show curation tools (Shift+M)'}
      aria-pressed={maintenance}
      variant="quiet"
      className={`${styles.modeToggle} ${maintenance ? styles.modeOn : ''}`}
      onClick={() => setMaintenance(!maintenance)}
    >
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7V20h3.3l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.5 2.5-2.4-.6-.6-2.4Z" /></svg>
    </IconButton>
  );

  return (
    <div className={styles.container}>
      <a href="#main-content" className={styles.skipLink}>Skip to content</a>
      <aside className={`${styles.nav} ${menuOpen ? styles.navOpen : ''} ${back ? styles.navDetail : ''}`}>
        {back && (
          <div className={styles.phoneBar}>
            {backButton}
            <span className={`${styles.barTitle} ${barTitle.shown ? styles.barTitleShown : ''}`} aria-hidden={!barTitle.shown}>{shownTitle}</span>
          </div>
        )}
        <Link to="/" className={styles.brand}>
          <BrandMark className={styles.brandMark} />
          tagave
          <span className={styles.brandCaption}>A home for your music</span>
        </Link>
        <div className={styles.tools}>
        <button ref={searchButton} className={styles.searchButton} onClick={() => setSearchOpen(true)} aria-haspopup="dialog" aria-label="Search your library">
          <svg className={styles.searchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <span className={styles.searchLabel}>Search</span> <kbd>⌘ K</kbd>
        </button>
        {maintenanceToggle}
        </div>
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
          <Link to="/" className={linkClass(pathname === '/')}>Home</Link>
          <Link to="/albums" search={albumsReturnSearch as never} className={linkClass(pathname.startsWith('/albums'))}>Albums</Link>
          <Link to="/artists" className={linkClass(pathname.startsWith('/artists'))}>Artists</Link>
          <Link to="/collection" className={linkClass(pathname.startsWith('/collection'))}>Physical collection</Link>
          <Link to="/work" search={{ tab: 'review' }} className={linkClass(['/work', '/queue', '/identify', '/attention'].some(p => pathname.startsWith(p)))} data-group="manage">Library care{taskCount > 0 && <span className={styles.navCount} title={`${taskCount} open ${taskCount === 1 ? 'task' : 'tasks'}`}><span className={styles.srOnly}>, </span>{taskCount}<span className={styles.srOnly}> open {taskCount === 1 ? 'task' : 'tasks'}</span></span>}</Link>
          <Link to="/plans" className={linkClass(pathname.startsWith('/plans'))}>Tag changes</Link>
          <Link to="/settings" className={linkClass(pathname.startsWith('/settings') || pathname.startsWith('/jobs'))}>Settings{updateAvailable && <UpdateDot />}</Link>
        </nav>
        <div className={styles.navUser}>
          <span className={styles.userEmail} title={user.email}>{user.email}</span>
          <Button variant="quiet" size="sm" className={styles.logoutBtn} disabled={logout.isPending} onClick={() => logout.mutate()}>{logout.isPending ? 'Signing out…' : 'Sign out'}</Button>
          {logout.isError && <p role="alert">Could not sign out. Please try again.</p>}
        </div>
        </div>
      </aside>
      <div className={styles.contentArea}>
        {/* The footer scrolls with the page instead of holding a strip of
            every screen; on a phone that strip cost a fifth of the height. */}
        <main id="main-content" ref={main} tabIndex={-1} className={styles.main}>
          {back && (
            <div className={`${styles.appBar} ${barTitle.shown ? styles.appBarScrolled : ''}`}>
              {backButton}
              <span className={`${styles.barTitle} ${barTitle.shown ? styles.barTitleShown : ''}`} aria-hidden={!barTitle.shown}>{shownTitle}</span>
            </div>
          )}
          <div className={styles.page}><Outlet /></div>
          <footer className={styles.footer}>tagave uses the Discogs API but is not affiliated with, sponsored or endorsed by Discogs. Discogs is a trademark of Zink Media, LLC.</footer>
        </main>
      </div>
      {searchOpen && <SearchModal onClose={closeSearch} />}
      <AlbumSelectionGuard />
    </div>
  );
}
