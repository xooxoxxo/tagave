/**
 * Main application layout with navigation
 */

import { useEffect, useState } from 'react';
import { Outlet, Link, useLocation } from '@tanstack/react-router';
import { useMe } from '../hooks';
import { SearchModal } from './SearchModal';
import styles from './Layout.module.css';

export function Layout() {
  const { data: user } = useMe();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);

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

  const isActive = (href: string) => location.pathname === href;

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
            className={isActive('/') ? styles.navLinkActive : styles.navLink}
          >
            Dashboard
          </Link>
          <Link
            to="/albums"
            className={isActive('/albums') ? styles.navLinkActive : styles.navLink}
          >
            Albums
          </Link>
          <Link
            to="/artists"
            className={isActive('/artists') ? styles.navLinkActive : styles.navLink}
          >
            Artists
          </Link>
          <Link
            to="/queue"
            className={isActive('/queue') ? styles.navLinkActive : styles.navLink}
          >
            Queue
          </Link>
          <Link
            to="/attention"
            className={isActive('/attention') ? styles.navLinkActive : styles.navLink}
          >
            Attention
          </Link>
          <Link
            to="/settings/scan-roots"
            className={isActive('/settings/scan-roots') ? styles.navLinkActive : styles.navLink}
          >
            Settings
          </Link>
          <Link
            to="/jobs"
            className={isActive('/jobs') ? styles.navLinkActive : styles.navLink}
          >
            Jobs
          </Link>
        </div>

        <div className={styles.navUser}>
          <span className={styles.userEmail}>{user.email}</span>
          <Link to="/logout" className={styles.logoutBtn}>
            Logout
          </Link>
        </div>
      </nav>

      <main className={styles.main}>
        <Outlet />
      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} />}
      </main>
    </div>
  );
}
