import { useEffect, useRef, useState } from 'react';
import { Outlet, Link, useLocation } from '@tanstack/react-router';
import { useMe, useCurrentLibrary, useJobEvents, useLogout, useGapCounts } from '../hooks';
import { SearchModal } from './SearchModal';
import { Button } from './ui';
import { BrandMark } from './BrandMark';
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
  useJobEvents(user && libraryId ? libraryId : undefined);
  // open tasks (gaps the owner took on) show as a count on Library care
  const taskCount = useGapCounts(user ? libraryId : undefined).data?.tasks?.todo ?? 0;

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
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!user) return <Outlet />;
  const linkClass = (active: boolean) => active ? styles.navLinkActive : styles.navLink;
  const closeSearch = () => { setSearchOpen(false); searchButton.current?.focus(); };

  return (
    <div className={styles.container}>
      <a href="#main-content" className={styles.skipLink}>Skip to content</a>
      <aside className={`${styles.nav} ${menuOpen ? styles.navOpen : ''}`}>
        <Link to="/" className={styles.brand}>
          <BrandMark className={styles.brandMark} />
          tagave
          <span className={styles.brandCaption}>A home for your music</span>
        </Link>
        <button ref={searchButton} className={styles.searchButton} onClick={() => setSearchOpen(true)} aria-haspopup="dialog" aria-label="Search your library">
          <svg className={styles.searchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <span className={styles.searchLabel}>Search your library</span> <kbd>⌘ K</kbd>
        </button>
        <button
          ref={menuButton}
          type="button"
          className={styles.menuButton}
          aria-expanded={menuOpen}
          aria-controls="main-navigation"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            {menuOpen ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
        <div id="main-navigation" className={styles.navSheet}>
        <nav className={styles.navLinks} aria-label="Main navigation">
          <Link to="/" className={linkClass(pathname === '/')}>Home</Link>
          <Link to="/albums" className={linkClass(pathname.startsWith('/albums'))}>Albums</Link>
          <Link to="/artists" className={linkClass(pathname.startsWith('/artists'))}>Artists</Link>
          <Link to="/collection" className={linkClass(pathname.startsWith('/collection'))}>Physical collection</Link>
          <Link to="/work" search={{ tab: 'review' }} className={linkClass(['/work', '/queue', '/identify', '/attention'].some(p => pathname.startsWith(p)))} data-group="manage">Library care{taskCount > 0 && <span className={styles.navCount} title={`${taskCount} open ${taskCount === 1 ? 'task' : 'tasks'}`}><span className={styles.srOnly}>, </span>{taskCount}<span className={styles.srOnly}> open {taskCount === 1 ? 'task' : 'tasks'}</span></span>}</Link>
          <Link to="/plans" className={linkClass(pathname.startsWith('/plans'))}>Tag changes</Link>
          <Link to="/settings" className={linkClass(pathname.startsWith('/settings') || pathname.startsWith('/jobs'))}>Settings</Link>
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
          <div className={styles.page}><Outlet /></div>
          <footer className={styles.footer}>tagave uses the Discogs API but is not affiliated with, sponsored or endorsed by Discogs. Discogs is a trademark of Zink Media, LLC.</footer>
        </main>
      </div>
      {searchOpen && <SearchModal onClose={closeSearch} />}
    </div>
  );
}
