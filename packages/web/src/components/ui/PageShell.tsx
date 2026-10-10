import { createContext, ReactNode, useContext, useId } from 'react';
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
  actions,
  tabs,
  activeTab = '',
  onTabChange,
  back = false,
  barTitle,
  hero,
  band,
  fill = false,
  children,
}: PageShellProps) {
  const panelId = useId();
  const barText = barTitle !== undefined ? barTitle : typeof title === 'string' ? title : null;
  return (
    <div className={fill ? styles.pageShellFill : styles.pageShell} data-page-shell="" data-virtual-page={fill ? '' : undefined}>
      <header className={styles.header}>
        {band && <div className={styles.band} aria-hidden="true">{band}</div>}
        {hero ?? (<>
          <div className={styles.titleBlock}>
            <div className={styles.titleRow}>
              {back && <PageBack />}
              {back ? <DetailTitle text={barText}>{title}</DetailTitle> : <h1 className={styles.title}>{title}</h1>}
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
