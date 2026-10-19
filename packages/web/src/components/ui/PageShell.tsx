import { createContext, ReactNode, RefObject, useContext, useId, useLayoutEffect, useRef } from 'react';
import { Tabs, TabItem } from './Tabs';
import { useBarTitle } from '../appBarTitle';
import styles from './PageShell.module.css';

/**
 * The page shell: every page in the app frame renders inside it, so moving
 * between pages never shifts the heading. One content column (left edge,
 * max width and top padding from --page-pad, --content-max and --page-top),
 * the heading row, optional tabs, then the page's content.
 *
 * Detail pages pass `back`: the back button sits inline to the left of the
 * title, and once the title scrolls away the app bar takes over both (the
 * Layout provides the button through PageBackContext, so the shell stays
 * free of routing).
 */

/** Renders the detail page's back button; null on top-level pages. */
export const PageBackContext = createContext<(() => ReactNode) | null>(null);

/** The detail page's way back (label and action), for a page that draws its own back key (the album). */
export const PageBackActionContext = createContext<{ label: string; go: () => void } | null>(null);

/** The back button for a custom header (the album hero): inline, phone-hidden. */
export function PageBack() {
  const render = useContext(PageBackContext);
  const button = render?.();
  if (!button) return null;
  return <span className={styles.back}>{button}</span>;
}

interface PageShellProps {
  /** The page heading (an h1). Omit only with `hero`. */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Quiet text on the heading's baseline (a count). */
  aside?: ReactNode;
  /** A control right after the heading, centred on it (Tag changes' plus button). */
  titleAction?: ReactNode;
  actions?: ReactNode;
  tabs?: TabItem[];
  activeTab?: string;
  onTabChange?: (value: string) => void;
  /** A detail page: the back button leads the title row. */
  back?: boolean;
  /** The text the app bar shows once the title scrolls away, when `title` is not plain text. */
  barTitle?: string | null;
  /** A custom header body in place of the title row (the album's cover and name). */
  hero?: ReactNode;
  /** A full-bleed decoration behind the header (edge to edge of the pane). */
  band?: ReactNode;
  /** A page whose list scrolls inside it (virtualised): the shell fills the pane. */
  fill?: boolean;
  /** A page that lays out its own header and column (the album flow): no header row, no content padding. */
  bare?: boolean;
  /**
   * The header stays at the top of the pane while the page scrolls under it
   * (Settings). The shell exposes the header's height as --shell-header-h
   * and the pane's visible height as --pane-h, so a sticky column inside
   * the content can sit just under it and scroll on its own.
   */
  sticky?: boolean;
  children: ReactNode;
}

function DetailTitle({ text, children }: { text: string | null; children: ReactNode }) {
  const ref = useBarTitle(text);
  return <h1 ref={ref} className={styles.title}>{children}</h1>;
}

export function PageShell({
  title,
  subtitle,
  aside,
  titleAction,
  actions,
  tabs,
  activeTab = '',
  onTabChange,
  back = false,
  barTitle,
  hero,
  band,
  fill = false,
  bare = false,
  sticky = false,
  children,
}: PageShellProps) {
  const panelId = useId();
  const shellRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  useStickyMetrics(sticky && !bare, shellRef, headerRef);
  const barText = barTitle !== undefined ? barTitle : typeof title === 'string' ? title : null;
  if (bare) return <div className={styles.pageShell} data-page-shell="">{children}</div>;
  // Only a heading in the header: on a phone the app's top bar names the
  // page, so the frame (Layout) hides the heading and this empty row.
  const titleOnly = !back && !hero && !band && !subtitle && !aside && !titleAction && !actions;
  return (
    <div ref={shellRef} className={fill ? styles.pageShellFill : styles.pageShell} data-page-shell="" data-virtual-page={fill ? '' : undefined}>
      <header ref={headerRef} className={sticky ? styles.headerSticky : styles.header} data-title-only={titleOnly ? '' : undefined}>
        {band && <div className={styles.band} aria-hidden="true">{band}</div>}
        {hero ?? (<>
          <div className={styles.titleBlock}>
            <div className={styles.titleRow}>
              {back && <PageBack />}
              {back ? <DetailTitle text={barText}>{title}</DetailTitle> : <h1 className={styles.title} data-page-title="">{title}</h1>}
              {titleAction && <span className={styles.titleAction}>{titleAction}</span>}
              {aside && <span className={styles.aside}>{aside}</span>}
            </div>
            {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </>)}
      </header>

      {tabs && tabs.length > 0 && (
        <div className={styles.tabs}>
          <Tabs panelId={panelId} items={tabs} value={activeTab} onChange={onTabChange} />
        </div>
      )}

      <div className={styles.content} id={tabs?.length ? panelId : undefined} role={tabs?.length ? "tabpanel" : undefined}>{children}</div>
    </div>
  );
}

/** Sets --shell-header-h and --pane-h on the shell while `on`, kept current as either resizes. */
function useStickyMetrics(on: boolean, shell: RefObject<HTMLDivElement | null>, header: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const root = shell.current;
    const head = header.current;
    if (!on || !root || !head) return;
    const pane = root.closest<HTMLElement>('#main-content');
    const update = () => {
      root.style.setProperty('--shell-header-h', `${head.offsetHeight}px`);
      if (pane) root.style.setProperty('--pane-h', `${pane.clientHeight}px`);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(head);
    if (pane) observer.observe(pane);
    return () => observer.disconnect();
  }, [on, shell, header]);
}
