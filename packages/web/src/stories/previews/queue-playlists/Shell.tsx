/**
 * The app's frame for the previews: the real Layout classes (sidebar on a
 * desktop, the one-row bar on a phone), the account row, a page, an optional
 * right-hand panel (direction A's queue) and the dock at the foot. Static:
 * no router state, no queries.
 */
import type { ReactNode } from 'react';
import { BrandMark } from '../../../components/BrandMark';
import { AccountCompartment } from '../../../components/AccountCompartment';
import layout from '../../../components/Layout.module.css';
import s from './Shell.module.css';

export type NavKey = 'home' | 'albums' | 'artists' | 'collection' | 'playlists' | 'work' | 'plans' | 'settings';

export interface ShellProps {
  active: NavKey | null;
  /** B: "Playlists" as a main page in the nav */
  playlistsLink?: boolean;
  /** A: the sidebar's Playlists section, under the links */
  sidebarSection?: ReactNode;
  /** the phone bar's title */
  title: string;
  /** a detail page on a phone: the bar is the page's own (back), no wordmark row */
  phoneDetail?: boolean;
  /** the phone's nav sheet is open */
  menuOpen?: boolean;
  children: ReactNode;
  /** A desktop: the queue / now playing panel at the right of the page */
  panel?: ReactNode;
  /** the player at the foot (desktop bar or phone mini bar) */
  dock?: ReactNode;
  /** something over the whole frame (full Now Playing, a dialog) */
  overlay?: ReactNode;
}

const back = <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>;

export function Shell({ active, playlistsLink = false, sidebarSection, title, phoneDetail = false, menuOpen = false, children, panel, dock, overlay }: ShellProps) {
  const link = (key: NavKey, label: string, extra?: Record<string, string>) => (
    <a href="#" onClick={(e) => e.preventDefault()} className={active === key ? layout.navLinkActive : layout.navLink} {...extra}>{label}</a>
  );
  return (
    <div className={`${layout.container} ${s.frame}`}>
      <aside className={`${layout.nav} ${menuOpen ? layout.navOpen : ''} ${phoneDetail ? `${layout.navDetail} ${s.detail}` : ''}`}>
        {phoneDetail && (
          <div className={layout.phoneBar}>
            <button type="button" className={`${s.backKey}`} aria-label="Back">{back}</button>
            <span className={`${layout.barTitle} ${layout.barTitleShown}`}>{title}</span>
          </div>
        )}
        <div className={layout.brandRow}>
          <a href="#" className={layout.brand} aria-label="tagave" onClick={(e) => e.preventDefault()}>
            <BrandMark className={layout.brandMark} />
            <span className={layout.wordmark}>tagave</span>
          </a>
          <span className={layout.pageTitle} aria-hidden="true">{title}</span>
          <div className={layout.tools}>
            <button type="button" className={layout.searchButton} aria-label="Search your library">
              <svg className={layout.searchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <span className={layout.searchLabel}>Search</span> <kbd>⌘ K</kbd>
            </button>
          </div>
        </div>
        <button type="button" className={layout.menuButton} aria-label="Open menu" aria-expanded={menuOpen}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            {menuOpen ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
        <div className={layout.navSheet}>
          <nav className={layout.navLinks} aria-label="Main navigation">
            {link('home', 'Home')}
            {link('albums', 'Albums')}
            {link('artists', 'Artists')}
            {link('collection', 'Physical collection')}
            {playlistsLink && link('playlists', 'Playlists')}
            {link('work', 'Library care', { 'data-group': 'manage' })}
            {link('plans', 'Tag changes')}
            {link('settings', 'Settings')}
          </nav>
          {sidebarSection}
          <div className={layout.account} data-account-row="">
            <AccountCompartment name="Oytun" email="owner@example.com" signingOut={false} closeKey="x" onAccount={() => undefined} onListening={() => undefined} onSignOut={() => undefined} />
          </div>
        </div>
      </aside>
      <div className={layout.contentArea}>
        <div className={s.row}>
          <main className={layout.main}>
            <div className={layout.page}>{children}</div>
          </main>
          {panel}
        </div>
        {dock}
      </div>
      {overlay}
    </div>
  );
}
