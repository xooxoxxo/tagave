/**
 * Main application layout with navigation
 */

import { useEffect, useState } from 'react';
import { Outlet, Link, useLocation } from '@tanstack/react-router';
import { useMe, useCurrentLibrary, useJobEvents } from '../hooks';
import { SearchModal } from './SearchModal';
import styles from './Layout.module.css';

export function Layout() {
  const { data: user } = useMe();
  const { libraryId } = useCurrentLibrary();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);

  // Mount SSE listener for job events and queue changes (once per library)
  useJobEvents(user && libraryId ? libraryId : undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!user) {
    // Not authenticated - no nav
    return <Outlet />;
  }

  const isLibraryActive = location.pathname.startsWith('/albums') || location.pathname.startsWith('/artists');
  const isWorkActive = location.pathname.startsWith('/work') || location.pathname.startsWith('/queue') || location.pathname.startsWith('/identify') || location.pathname.startsWith('/attention');
  const isPlansActive = location.pathname.startsWith('/plans');
  const isSettingsActive = location.pathname.startsWith('/settings') || location.pathname.startsWith('/collection') || location.pathname.startsWith('/jobs');

  return (
    <div className={styles.container}>
      <nav className={styles.nav}>
        <div className={styles.navBrand}>
          <Link to="/" className={styles.brand}>
            Liner
          </Link>
        </div>

        <button className={styles.searchButton} onClick={() => setSearchOpen(true)}>
          Search <kbd className={styles.kbd}>⌘K</kbd>
        </button>

        <div className={styles.navLinks}>
          <Link
            to="/"
            className={location.pathname === '/' ? styles.navLinkActive : styles.navLink}
          >
            Home
          </Link>
          <Link
            to="/albums"
            className={isLibraryActive ? styles.navLinkActive : styles.navLink}
          >
            Library
          </Link>
          <Link
            to="/work"
            search={{ tab: 'review' }}
            className={isWorkActive ? styles.navLinkActive : styles.navLink}
          >
            Work
          </Link>
          <Link
            to="/plans"
            className={isPlansActive ? styles.navLinkActive : styles.navLink}
          >
            Plans
          </Link>
          <Link
            to="/settings"
            className={isSettingsActive ? styles.navLinkActive : styles.navLink}
          >
            Settings
          </Link>
        </div>

        <div className={styles.navUser}>
          <span className={styles.userEmail}>{user.email}</span>
          <Link to="/logout" className={styles.logoutBtn}>
            Logout
          </Link>
        </div>
      </nav>

      <div className={styles.contentWrapper}>
        <main className={styles.main}>
          <Outlet />
        {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} />}
        </main>

        <footer className={styles.footer}>
          <span className={styles.footerText}>
            This application uses Discogs' API but is not affiliated with, sponsored or endorsed by Discogs. 'Discogs' is a trademark of Zink Media, LLC.
          </span>
        </footer>
      </div>
    </div>
  );
}
