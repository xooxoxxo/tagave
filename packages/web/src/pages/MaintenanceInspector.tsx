/**
 * The Maintenance inspector (owner's pick, 2026-11-05: "B · Inspector", a full
 * sidebar on a desktop): the album's upkeep in one quiet column of groups,
 * labels and values only.
 *
 *   State      the state pill, Any edition ✕, Discogs only, provider links
 *   To fix     a slim meter ("1 of 3") and one line per issue: a mark, the
 *              label, its main action as a text button; the line opens its
 *              body in place. A fixed or dismissed issue ticks off
 *              (utils/maintenanceInspector.ts). The manual match and the
 *              passing status note live here too.
 *   Selection  only while songs are picked
 *   Tools      Tag…, Move songs…, Match to a release, the folder tools
 *   Sections   Tracks, Editions, About, Activity: shown in the main column
 *
 * The same groups fill the desktop's sidebar and the phone's sheet
 * (MaintenanceSheet). On a phone the page shows MaintenanceSummary, one row
 * that opens the sheet, and PickBar floats while songs are picked.
 */
import { Fragment, useEffect, useId, type ReactNode } from 'react';
import { Collapse, CloseIcon } from '../components/ui';
import type { AlbumTab, AttentionItem } from '../utils/albumAttention';
import { meterFill, meterLabel, summaryLabel, type FixMeter, type InspectorRow } from '../utils/maintenanceInspector';
import styles from './MaintenanceInspector.module.css';

export interface InspectorStateModel {
  /** the album's state key (matched, needs_review…) */
  state: string;
  label: string;
  /** matched to the release group only: Any edition ✕ pins one again */
  onClearAnyEdition: (() => void) | null;
  discogsOnly: boolean;
  links: Array<{ label: string; href: string }>;
}

export interface InspectorTool {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean | undefined;
}

export interface InspectorSelection {
  count: number;
  all: boolean;
  onAll: () => void;
  onMove: () => void;
  /** the library's delete ("Mark for deletion" / "Move to trash"); null without it */
  deleteLabel: string | null;
  onDelete: () => void;
  onClear: () => void;
}

export interface InspectorSections {
  value: AlbumTab;
  onChange: (tab: AlbumTab) => void;
  /** a request is running: Activity carries the live dot */
  live: boolean;
}

export interface MaintenanceInspectorProps {
  variant: 'side' | 'sheet';
  state: InspectorStateModel;
  rows: InspectorRow[];
  meter: FixMeter;
  openRows: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onAction: (item: AttentionItem) => void;
  body: (item: AttentionItem) => ReactNode;
  busy?: ((item: AttentionItem) => boolean) | undefined;
  /** a passing status (cover art lookup, identify running…) */
  note?: { text: string; live: boolean; onDismiss: () => void; action?: ReactNode } | null | undefined;
  /** the manual "Match to a release" panel, when it is open */
  manual?: ReactNode;
  selection?: InspectorSelection | null | undefined;
  tools: InspectorTool[];
  upgrade?: ReactNode;
  embedCover?: ReactNode;
  sections: InspectorSections;
  /** a row a deep link opened: brought into view */
  reveal?: string | null | undefined;
}

const SECTION_LABELS: ReadonlyArray<readonly [AlbumTab, string]> = [
  ['tracks', 'Tracks'],
  ['editions', 'Editions'],
  ['about', 'About'],
  ['activity', 'Activity'],
];

/** the row's DOM id (also its body's, with -body) */
export const inspectorRowId = (id: string) => `fix-${id.replace(/[^a-z0-9-]/gi, '')}`;

export function FixMeterBar({ meter, className }: { meter: FixMeter; className?: string | undefined }) {
  const fill = meterFill(meter);
  return (
    <span className={[styles.meter, className].filter(Boolean).join(' ')} aria-hidden="true">
      <span className={styles.meterFill} style={{ transform: `scaleX(${fill})` }} data-full={fill >= 1 || undefined} />
    </span>
  );
}

function Mark({ row }: { row: InspectorRow }) {
  return (
    <span className={styles.mark} data-mark={row.ticked ? 'done' : row.item.tone} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16">
        <circle className={styles.markRing} cx="8" cy="8" r="6.25" />
        <path className={styles.markCheck} d="M5 8.3 7 10.2 11 6" pathLength={1} />
      </svg>
    </span>
  );
}

/**
 * "Whole album in one file · 1 file · 11 tracks · 1:18:32": a long line
 * breaks between its values, never inside a short one.
 */
function LineParts({ line }: { line: string }) {
  return <>{line.split(' · ').map((part, i) => (
    <Fragment key={i}>{i > 0 && ' · '}<span className={part.length <= 16 ? styles.linePart : undefined}>{part}</span></Fragment>
  ))}</>;
}

export function MaintenanceInspector(p: MaintenanceInspectorProps) {
  const labelId = useId();
  useEffect(() => {
    if (!p.reveal) return;
    const el = document.getElementById(inspectorRowId(p.reveal));
    if (!el) return;
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' }));
  }, [p.reveal]);

  const group = (key: string, title: string, children: ReactNode) => (
    <section className={styles.group} aria-labelledby={`${labelId}-${key}`}>
      <h3 id={`${labelId}-${key}`} className={styles.groupTitle}>{title}</h3>
      {children}
    </section>
  );

  const s = p.state;
  return (
    <div className={styles.inspector} data-variant={p.variant}>
      {group('state', 'State', (
        <div className={styles.stateLine}>
          <span className={styles.pill} data-state={s.state}>{s.label}</span>
          {s.onClearAnyEdition && (
            <button type="button" className={styles.pillButton} onClick={s.onClearAnyEdition} title="Pin one edition again">Any edition <CloseIcon /></button>
          )}
          {s.discogsOnly && <span className={`${styles.pill} ${styles.pillMuted}`}>Discogs only</span>}
          {s.links.map((l) => (
            <a key={l.href} className={styles.link} href={l.href} target="_blank" rel="noreferrer">{l.label} ↗</a>
          ))}
        </div>
      ))}

      {group('fix', 'To fix', (<>
        <div className={styles.meterRow}>
          <FixMeterBar meter={p.meter} />
          <span className={styles.meterText} aria-live="polite">{meterLabel(p.meter)}</span>
        </div>
        {p.note && (
          <p className={styles.note} role="status">
            {p.note.live && <span className={styles.spinner} aria-hidden="true" />}
            <span>{p.note.text}</span>
            {p.note.action}
            {!p.note.live && <button type="button" className={styles.noteDismiss} onClick={p.note.onDismiss} aria-label="Dismiss"><CloseIcon /></button>}
          </p>
        )}
        <Collapse open={!!p.manual}>
          <div className={styles.manual}>{p.manual}</div>
        </Collapse>
        {p.rows.length > 0 && (
          <ul className={styles.rows}>
            {p.rows.map((row) => {
              const { item, ticked } = row;
              const isOpen = !ticked && p.openRows.has(item.id);
              const rowId = inspectorRowId(item.id);
              const bodyId = `${rowId}-body`;
              const action = item.action;
              const showAction = !!action && !ticked && !(action.do === 'expand' && isOpen);
              const busy = !ticked && (p.busy?.(item) ?? false);
              return (
                <li key={item.id} id={rowId} className={styles.row} data-open={isOpen || undefined} data-ticked={ticked || undefined}>
                  <div className={styles.rowHead}>
                    <button
                      type="button"
                      className={styles.rowToggle}
                      aria-expanded={ticked ? undefined : isOpen}
                      aria-controls={ticked ? undefined : bodyId}
                      disabled={ticked}
                      onClick={() => p.onToggle(item.id)}
                    >
                      <Mark row={row} />
                      <span className={styles.rowLine}>
                        {ticked && <span className={styles.srOnly}>Done: </span>}
                        <LineParts line={item.line} />
                      </span>
                    </button>
                    <span className={styles.rowAction} data-hidden={!showAction || undefined}>
                      {action && (
                        <button
                          type="button"
                          className={styles.textButton}
                          tabIndex={showAction ? undefined : -1}
                          aria-hidden={!showAction || undefined}
                          disabled={busy}
                          aria-busy={busy || undefined}
                          aria-expanded={action.do === 'expand' ? isOpen : undefined}
                          aria-controls={action.do === 'expand' ? bodyId : undefined}
                          onClick={() => (action.do === 'expand' ? p.onToggle(item.id) : p.onAction(item))}
                        >
                          {busy ? `${action.label}…` : action.label}
                        </button>
                      )}
                    </span>
                  </div>
                  {!ticked && (
                    <Collapse open={isOpen} id={bodyId}>
                      <div className={styles.rowBody}>{p.body(item)}</div>
                    </Collapse>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </>))}

      {p.selection && p.selection.count > 0 && group('selection', 'Selection', (
        <div className={styles.selection}>
          <span className={styles.selCount}>{p.selection.count} selected</span>
          <div className={styles.list}>
            {!p.selection.all && <button type="button" className={styles.item} onClick={p.selection.onAll}>Select all</button>}
            <button type="button" className={styles.item} onClick={p.selection.onMove}>Move to album…</button>
            {p.selection.deleteLabel && <button type="button" className={`${styles.item} ${styles.danger}`} onClick={p.selection.onDelete}>{p.selection.deleteLabel}</button>}
            <button type="button" className={styles.item} onClick={p.selection.onClear}>Clear</button>
          </div>
        </div>
      ))}

      {p.upgrade && group('flac-upgrade', 'Upgrade to FLAC', p.upgrade)}
      {p.embedCover && group('embed-cover', 'Embed cover art', p.embedCover)}

      {p.tools.length > 0 && group('tools', 'Tools', (
        <div className={styles.list}>
          {p.tools.map((t) => (
            <button key={t.key} type="button" className={styles.item} disabled={t.disabled} onClick={t.onSelect}>{t.label}</button>
          ))}
        </div>
      ))}

      {group('sections', 'Sections', (
        <div className={styles.list}>
          {SECTION_LABELS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={styles.item}
              aria-current={p.sections.value === value ? 'true' : undefined}
              onClick={() => p.sections.onChange(value)}
            >
              <span>{label}</span>
              {value === 'activity' && p.sections.live && <span className={styles.liveDot} aria-label=" (a request is running)" />}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The phone's one row under the album: "To fix · 3" with the meter; it opens the sheet. */
export function MaintenanceSummary({ meter, onOpen, open }: { meter: FixMeter; onOpen: (button: HTMLElement) => void; open: boolean }) {
  return (
    <button type="button" className={styles.summary} aria-haspopup="dialog" aria-expanded={open} onClick={(e) => onOpen(e.currentTarget)}>
      <span className={styles.summaryLabel}>{summaryLabel(meter)}</span>
      {meter.total > 0 && <FixMeterBar meter={meter} className={styles.summaryMeter} />}
      <svg className={styles.summaryChevron} viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
    </button>
  );
}

/** The phone's floating bar while songs are picked: "2 · Move… · Delete · ✕". */
export function PickBar({ selection }: { selection: InspectorSelection }) {
  const on = selection.count > 0;
  return (
    <div className={styles.floatLayer} data-on={on || undefined}>
      <div className={styles.float} role="toolbar" aria-label="Selected songs" inert={!on}>
        <span className={styles.floatCount} aria-live="polite">{selection.count}<span className={styles.srOnly}> selected</span></span>
        <button type="button" className={styles.floatButton} onClick={selection.onMove}>Move…</button>
        {selection.deleteLabel && <button type="button" className={`${styles.floatButton} ${styles.floatDanger}`} onClick={selection.onDelete}>Delete</button>}
        <button type="button" className={styles.floatClose} onClick={selection.onClear} aria-label="Clear selection"><CloseIcon /></button>
      </div>
    </div>
  );
}
