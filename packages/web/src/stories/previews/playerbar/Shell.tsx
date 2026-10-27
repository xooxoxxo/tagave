/**
 * The app's desktop frame for the persistent-bar previews (rr55,
 * branch-local): Layout's own classes, the real AccountCompartment at the
 * sidebar's foot, a page, and the bar under it. Like PlayerBar, it tells the
 * page how tall the bar is (--player-bar-h on <html>), so the account row
 * shares the bar's top edge. Static: no router state, no queries.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { BrandMark } from '../../../components/BrandMark';
import { AccountCompartment } from '../../../components/AccountCompartment';
import layout from '../../../components/Layout.module.css';
import bar from '../../../components/PlayerBar.module.css';

const noop = () => undefined;

export function Shell({ children, dock, compartmentOpen = false }: { children: ReactNode; dock: ReactNode; compartmentOpen?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
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
  const link = (label: string, active = false, group?: string) => (
    <a href="#" onClick={(e) => e.preventDefault()} className={active ? layout.navLinkActive : layout.navLink} data-group={group}>{label}</a>
  );
  return (
    <div className={layout.container}>
      <aside className={layout.nav}>
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
            {link('Library care', false, 'manage')}
            {link('Tag changes')}
            {link('Settings')}
          </nav>
          <div className={layout.account} data-account-row="">
            <AccountCompartment name="Oytun" email="owner@example.com" defaultOpen={compartmentOpen} onAccount={noop} onListening={noop} onSignOut={noop} />
          </div>
        </div>
      </aside>
      <div className={layout.contentArea}>
        <main id="main-content" tabIndex={-1} className={layout.main}>
          <div className={layout.page}>{children}</div>
        </main>
        <div ref={ref} className={bar.dock} data-player-bar="">{dock}</div>
      </div>
    </div>
  );
}
