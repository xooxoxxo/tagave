/**
 * The app's desktop frame for stories: Layout's own classes, the real
 * AccountCompartment at the sidebar's foot, a page, and the player bar's
 * row under it. Like PlayerBar, it tells the page how tall the bar is
 * (--player-bar-h on <html>), so the account row shares the bar's top edge.
 * Static: no router state, no queries. `sidebar` picks Settings ›
 * Appearance › Sidebar; with Auto-hide the frame runs the app's own
 * behaviour (sidebarPeek.ts), the pin and ⌘\ included.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { PEEK_QUERY, isPinShortcut, sidebarMode, useSidebarPeek } from '../components/sidebarPeek';
import { PeekMark, SidebarPin } from '../components/SidebarPin';
import { BrandMark } from '../components/BrandMark';
import { AccountCompartment } from '../components/AccountCompartment';
import layout from '../components/Layout.module.css';
import bar from '../components/PlayerBar.module.css';

const noop = () => undefined;
const careLinks = [
  { key: 'settings', label: 'Settings', onSelect: noop },
  { key: 'work', label: 'Library care', onSelect: noop },
  { key: 'plans', label: 'Tag changes', onSelect: noop },
];

export function DesktopFrame({ children, dock, empty = false, compartmentOpen = false, sidebar: pref = 'always', pinned: startPinned = false, revealed = false }: {
  children: ReactNode;
  dock: ReactNode;
  empty?: boolean;
  compartmentOpen?: boolean;
  sidebar?: 'always' | 'autoHide';
  /** Auto-hide: pinned to begin with */
  pinned?: boolean;
  /** Auto-hide: shown to begin with (as after the pointer came in) */
  revealed?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [pinned, setPinned] = useState(startPinned);
  const sidebar = sidebarMode({ sidebarAutoHide: pref === 'autoHide', sidebarPinned: pinned }, useMediaQuery(PEEK_QUERY));
  const peekOn = sidebar !== 'always';
  const peek = useSidebarPeek(navRef, peekOn, sidebar === 'pinned', useCallback(() => mainRef.current?.focus({ preventScroll: true }), []), revealed);
  const togglePin = useCallback(() => setPinned((p) => !p), []);
  useLayoutEffect(() => {
    if (!peekOn) return;
    const onKey = (e: KeyboardEvent) => { if (isPinShortcut(e)) { e.preventDefault(); togglePin(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [peekOn, togglePin]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const node = ref.current;
    if (!node) return;
    root.dataset['playerBar'] = '';
    const write = () => root.style.setProperty('--player-bar-h', `${node.getBoundingClientRect().height}px`);
    write();
    const ro = new ResizeObserver(write);
    ro.observe(node);
    return () => {
      ro.disconnect();
      delete root.dataset['playerBar'];
      root.style.removeProperty('--player-bar-h');
    };
  }, []);
  const link = (label: string, active = false) => (
    <a href="#" onClick={(e) => e.preventDefault()} className={active ? layout.navLinkActive : layout.navLink}>{label}</a>
  );
  return (
    <div className={layout.container} data-sidebar={peekOn ? sidebar : undefined} data-peek-shown={sidebar === 'peek' && peek.shown ? '' : undefined}>
      <aside ref={navRef} className={layout.nav}>
        <div className={layout.brandRow}>
          <a href="#" className={layout.brand} aria-label="tagave" onClick={(e) => e.preventDefault()}>
            <BrandMark className={layout.brandMark} />
            <span className={layout.wordmark}>tagave</span>
          </a>
          <div className={layout.tools}>
            <button type="button" className={layout.searchButton} aria-label="Search your library">
              <svg className={layout.searchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <span className={layout.searchLabel}>Search</span> <kbd>⌘ K</kbd>
            </button>
          </div>
        </div>
        <div className={layout.navSheet}>
          <nav className={layout.navLinks} aria-label="Main navigation">
            {link('Home')}
            {link('Albums', true)}
            {link('Artists')}
            {link('Physical collection')}
          </nav>
          {peekOn && <SidebarPin pinned={sidebar === 'pinned'} onToggle={togglePin} />}
          <div className={layout.account} data-account-row="">
            <AccountCompartment name="Oytun" email="owner@example.com" defaultOpen={compartmentOpen} onAccount={noop} onListening={noop} onSignOut={noop} links={careLinks} />
          </div>
        </div>
      </aside>
      {sidebar === 'peek' && <PeekMark />}
      <div className={layout.contentArea}>
        <main id="main-content" ref={mainRef} tabIndex={-1} className={layout.main}>
          <div className={layout.page}>{children}</div>
        </main>
        <div ref={ref} className={bar.dock} data-player-bar="" data-empty={empty ? '' : undefined}>{dock}</div>
      </div>
    </div>
  );
}
