import { useEffect, useRef, useState } from 'react';
import { Outlet, Link, useLocation } from '@tanstack/react-router';
import { useMe, useCurrentLibrary, useJobEvents, useLogout } from '../hooks';
import { SearchModal } from './SearchModal';
import styles from './Layout.module.css';

export function Layout() {
  const { data: user } = useMe();
  const { libraryId } = useCurrentLibrary();
  const { pathname } = useLocation();
  const logout = useLogout();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  useJobEvents(user && libraryId ? libraryId : undefined);

  useEffect(() => { main.current?.scrollTo(0, 0); }, [pathname]);
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
      <aside className={styles.nav}>
        <Link to="/" className={styles.brand}><span className={styles.brandMark} aria-hidden="true">≋</span>Liner<span className={styles.brandCaption}>A home for your music</span></Link>
        <button ref={searchButton} className={styles.searchButton} onClick={() => setSearchOpen(true)} aria-haspopup="dialog">Search your library <kbd>⌘ K</kbd></button>
        <nav className={styles.navLinks} aria-label="Main navigation">
          <span className={styles.groupLabel}>Your music</span>
          <Link to="/" className={linkClass(pathname === '/')}>Home</Link>
          <Link to="/albums" className={linkClass(pathname.startsWith('/albums'))}>Albums</Link>
          <Link to="/artists" className={linkClass(pathname.startsWith('/artists'))}>Artists</Link>
          <Link to="/collection" className={linkClass(pathname.startsWith('/collection'))}>Physical collection</Link>
          <span className={styles.groupLabel}>Manage library</span>
          <Link to="/work" search={{ tab: 'review' }} className={linkClass(['/work', '/queue', '/identify', '/attention'].some(p => pathname.startsWith(p)))}>Library care</Link>
          <Link to="/plans" className={linkClass(pathname.startsWith('/plans'))}>Tag changes</Link>
          <Link to="/settings" className={linkClass(pathname.startsWith('/settings') || pathname.startsWith('/jobs'))}>Settings</Link>
        </nav>
        <div className={styles.navUser}>
          <span className={styles.userEmail}>{user.email}</span>
          <button className={styles.logoutBtn} disabled={logout.isPending} onClick={() => logout.mutate()}>{logout.isPending ? 'Signing out…' : 'Sign out'}</button>
          {logout.isError && <p role="alert">Could not sign out. Please try again.</p>}
        </div>
      </aside>
      <main id="main-content" ref={main} tabIndex={-1} className={styles.main}>
        <div className={styles.page}><Outlet /></div>
        <footer className={styles.footer}>Liner uses the Discogs API but is not affiliated with, sponsored or endorsed by Discogs. Discogs is a trademark of Zink Media, LLC.</footer>
      </main>
      {searchOpen && <SearchModal onClose={closeSearch} />}
    </div>
  );
}
