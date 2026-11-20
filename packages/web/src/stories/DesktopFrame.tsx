/**
 * The app's frame for stories: Layout's own classes, the real IdentityRow at
 * the sidebar's top, Browse and Care from navModel (nothing at the foot), a
 * page, and the player bar's row under both, the frame's full width. Like
 * PlayerBar, it tells the page how tall the bar is (--player-bar-h on
 * <html>). At phone width it is the phone's bar; `sheetOpen` opens its sheet.
 * Static: no router state, no queries. `sidebar` picks Settings ›
 * Appearance › Sidebar; with Auto-hide the frame runs the app's own
 * behaviour (sidebarPeek.ts), the pin included.
 */
import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { PEEK_QUERY, sidebarMode, useSidebarPeek } from '../components/sidebarPeek';
import { PeekMark, SidebarPin } from '../components/SidebarPin';
import { BrandMark } from '../components/BrandMark';
import { IdentityRow } from '../components/IdentityRow';
import { identityDot, sidebarNav } from '../components/navModel';
import layout from '../components/Layout.module.css';
import bar from '../components/PlayerBar.module.css';

const noop = () => undefined;

/** Who is signed in, and what the sidebar shows them. */
export interface FramePerson {
  name: string;
  email: string;
  /** library.edit: the Care group */
  canCare: boolean;
  /** a Settings section is theirs (settingsNav): the menu's Settings item */
  hasSettings: boolean;
  /** system.manage: the update dot is theirs */
  owner: boolean;
  updateAvailable?: boolean;
  taskCount?: number;
}

export const OWNER: FramePerson = { name: 'Robin', email: 'robin@example.com', canCare: true, hasSettings: true, owner: true };

export function DesktopFrame({
  children, dock, empty = false, sidebar: pref = 'always', pinned: startPinned = false, revealed = false,
  person = OWNER, showWordmark = true, searchPlacement = 'below', pathname = '/albums', sheetOpen = false,
}: {
  children: ReactNode;
  dock: ReactNode;
  empty?: boolean;
  sidebar?: 'always' | 'autoHide';
  /** Auto-hide: pinned to begin with */
  pinned?: boolean;
  /** Auto-hide: shown to begin with (as after the pointer came in) */
  revealed?: boolean;
  person?: FramePerson;
  showWordmark?: boolean;
  searchPlacement?: 'below' | 'beside';
  /** the page shown, for the current link */
  pathname?: string;
  /** phone: the menu sheet open to begin with */
  sheetOpen?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [pinned, setPinned] = useState(startPinned);
  const [menuOpen, setMenuOpen] = useState(sheetOpen);
  const sidebar = sidebarMode({ sidebarAutoHide: pref === 'autoHide', sidebarPinned: pinned }, useMediaQuery(PEEK_QUERY));
  const peekOn = sidebar !== 'always';
  const peek = useSidebarPeek(navRef, peekOn, sidebar === 'pinned', useCallback(() => mainRef.current?.focus({ preventScroll: true }), []), revealed);
  const togglePin = useCallback(() => setPinned((p) => !p), []);
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
  // the phone's sheet opens under the bar: it needs the bar's height (as Layout)
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!menuOpen || !nav) return;
    nav.style.setProperty('--nav-bar-h', `${nav.getBoundingClientRect().bottom}px`);
  }, [menuOpen]);
  const { browse, care } = sidebarNav({ pathname, canCare: person.canCare, taskCount: person.taskCount ?? 0, modules: { playlists: false, likes: true, books: false } });
  const dot = identityDot({ owner: person.owner, updateAvailable: !!person.updateAvailable });
  const stay = (e: MouseEvent) => e.preventDefault();
  const searchKey = (place: string) => (
    <button type="button" className={`${layout.searchButton} ${place}`} aria-label="Search your library">
      <svg className={layout.searchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <span className={layout.searchLabel}>Search</span> <kbd>⌘ K</kbd>
    </button>
  );
  const beside = searchPlacement === 'beside';
  return (
    <div className={layout.container} data-sidebar={peekOn ? sidebar : undefined} data-peek-shown={sidebar === 'peek' && peek.shown ? '' : undefined}>
      <aside ref={navRef} className={`${layout.nav} ${menuOpen ? layout.navOpen : ''}`}>
        <a href="#" className={layout.brand} aria-label="tagave" onClick={stay}>
          <BrandMark className={layout.brandMark} />
        </a>
        <span className={layout.pageTitle} aria-hidden="true">Albums</span>
        {searchKey(layout.barSearch ?? '')}
        <button
          type="button"
          className={layout.menuButton}
          aria-expanded={menuOpen}
          aria-controls="frame-navigation"
          aria-label={menuOpen ? 'Close menu' : dot ? `Open menu (${dot})` : 'Open menu'}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            {menuOpen ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
          {dot && !menuOpen && <span className={layout.menuDot} aria-hidden="true" />}
        </button>
        <div id="frame-navigation" className={layout.navSheet}>
          <div className={layout.identity}>
            <IdentityRow
              name={person.name}
              email={person.email}
              showWordmark={showWordmark}
              {...(beside ? { search: searchKey(layout.sideSearch ?? '') } : {})}
              hasSettings={person.hasSettings}
              dot={dot}
              onNavigate={noop}
              onSignOut={noop}
            />
          </div>
          {!beside && <div className={layout.tools}>{searchKey(layout.sideSearch ?? '')}</div>}
          <nav className={layout.navLinks} aria-label="Main navigation">
            {browse.map((item) => (
              <a key={item.key} href="#" onClick={stay} className={item.current ? layout.navLinkActive : layout.navLink}>{item.label}</a>
            ))}
          </nav>
          {care.length > 0 && (
            <nav className={layout.navGroup} aria-labelledby="frame-care">
              <h2 id="frame-care" className={layout.navGroupLabel}>Care</h2>
              {care.map((item) => (
                <a key={item.key} href="#" onClick={stay} className={item.current ? layout.navLinkActive : layout.navLink}>
                  <span className={layout.navLabel}>{item.label}</span>
                  {!!item.count && <span className={layout.navCount}><span className={layout.srOnly}>, </span>{item.count}<span className={layout.srOnly}> {item.countLabel}</span></span>}
                </a>
              ))}
            </nav>
          )}
          {peekOn && <SidebarPin pinned={sidebar === 'pinned'} onToggle={togglePin} />}
        </div>
      </aside>
      {sidebar === 'peek' && <PeekMark />}
      <div className={layout.contentArea}>
        <main id="main-content" ref={mainRef} tabIndex={-1} className={layout.main}>
          <div className={layout.page}>{children}</div>
        </main>
      </div>
      <div className={layout.playerRow}>
        <div ref={ref} className={bar.dock} data-player-bar="" data-empty={empty ? '' : undefined}>{dock}</div>
      </div>
    </div>
  );
}
