/**
 * Album grid filter rail (spec BRW-1, §14.2): one section per dimension with
 * facet counts over the current result set. Dimensions listed in
 * MULTI_FILTER_KEYS accept several values at once (checkboxes); the rest are
 * single-select. Every choice is written to the URL by the page.
 */
import { useState } from 'react';
import type { AlbumFacets, AlbumsQuery, MultiFilterKey, SavedView } from '@liner/shared';
import { isMultiActive } from '../pages/albumsSearch';
import styles from './FilterRail.module.css';

interface FilterRailProps {
  query: AlbumsQuery;
  facets: AlbumFacets | undefined;
  savedViews: SavedView[] | undefined;
  activeCount: number;
  /** Toggle one value of a multi-select dimension. */
  onToggle: (key: MultiFilterKey, value: string | number) => void;
  /** Replace a single-select dimension (undefined clears it). */
  onSet: (key: 'decided' | 'review' | 'owned', value: string | undefined) => void;
  onClear: () => void;
  onApplyView: (view: SavedView) => void;
  onSaveView: () => void;
  onDeleteView: (id: string) => void;
}

const STATE_LABEL: Record<string, string> = {
  matched: 'Matched', needs_review: 'Needs review', unidentified: 'Unidentified', pending: 'Pending', as_is: 'Kept as-is', ignored: 'Ignored',
};
const FORMAT_LABEL: Record<string, string> = { lossless: 'Lossless', lossy: 'Lossy', mixed: 'Mixed' };
const REVIEW_LABEL: Record<string, string> = { reviewed: 'Reviewed', unreviewed: 'Unreviewed', rated: 'Rated', listened: 'Listened' };
const GAP_LABEL: Record<string, string> = { incomplete_album: 'Incomplete', duplicate: 'Duplicate', quality: 'Quality flags', none: 'No open issues' };
const OWNED_LABEL: Record<string, string> = { both: 'Also on physical', digital: 'Digital only' };
const DECIDED_LABEL: Record<string, string> = {
  auto_strong: 'Auto (strong)', chip_rule: 'Auto (chip rule)', first_candidate: 'Auto (first candidate)', by_me: 'Accepted by me', manual_mbid: 'Manual MBID',
};

type FacetItem = { value: string; label?: string | undefined; count: number };

function Section({ title, count, children, defaultOpen = true }: {
  title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={styles.section}>
      <button className={styles.sectionHead} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>{title}{count ? <span className={styles.badge}>{count}</span> : null}</span>
        <span className={styles.chevron}>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className={styles.options}>{children}</div>}
    </section>
  );
}

/** Checkbox list: several values can be on at once. */
function MultiOptions({ items, labels, isActive, onToggle, hideZero = true }: {
  items: FacetItem[] | undefined;
  labels?: Record<string, string>;
  isActive: (value: string) => boolean;
  onToggle: (value: string) => void;
  hideZero?: boolean;
}) {
  if (!items) return <div className={styles.muted}>…</div>;
  const visible = items.filter((i) => !hideZero || i.count > 0 || isActive(i.value));
  if (visible.length === 0) return <div className={styles.muted}>none</div>;
  return (
    <>
      {visible.map((i) => {
        const active = isActive(i.value);
        const label = i.label ?? labels?.[i.value] ?? i.value;
        return (
          <label key={i.value} className={active ? styles.optionActive : styles.option} title={label}>
            <input type="checkbox" className={styles.checkbox} checked={active} onChange={() => onToggle(i.value)} />
            <span className={styles.optionLabel}>{label}</span>
            <span className={styles.count}>{i.count.toLocaleString()}</span>
          </label>
        );
      })}
    </>
  );
}

/** Radio-style list: picking a value replaces the previous one, clicking it again clears. */
function SingleOptions({ items, labels, current, onPick, hideZero = true }: {
  items: FacetItem[] | undefined;
  labels?: Record<string, string>;
  current: string | undefined;
  onPick: (value: string | undefined) => void;
  hideZero?: boolean;
}) {
  if (!items) return <div className={styles.muted}>…</div>;
  const visible = items.filter((i) => !hideZero || i.count > 0 || current === i.value);
  if (visible.length === 0) return <div className={styles.muted}>none</div>;
  return (
    <>
      {visible.map((i) => {
        const active = current === i.value;
        const label = i.label ?? labels?.[i.value] ?? i.value;
        return (
          <button
            key={i.value}
            className={active ? styles.optionActive : styles.option}
            onClick={() => onPick(active ? undefined : i.value)}
            title={label}
          >
            <span className={styles.optionLabel}>{label}</span>
            <span className={styles.count}>{i.count.toLocaleString()}</span>
          </button>
        );
      })}
    </>
  );
}

export function FilterRail({ query, facets, savedViews, activeCount, onToggle, onSet, onClear, onApplyView, onSaveView, onDeleteView }: FilterRailProps) {
  const [genreQuery, setGenreQuery] = useState('');
  const [labelQuery, setLabelQuery] = useState('');
  const genres = facets?.genres.filter((g) => !genreQuery || g.value.toLowerCase().includes(genreQuery.toLowerCase()));
  const labels = facets?.labels.filter((l) => !labelQuery || l.value.toLowerCase().includes(labelQuery.toLowerCase()));
  const on = (key: MultiFilterKey) => (value: string) => onToggle(key, key === 'decade' ? Number(value) : value);
  const active = (key: MultiFilterKey) => (value: string) => isMultiActive(query, key, key === 'decade' ? Number(value) : value);
  const len = (key: MultiFilterKey) => (query[key]?.length ?? 0);

  return (
    <aside className={styles.rail}>
      <div className={styles.railHead}>
        <span className={styles.total}>{facets ? `${facets.total.toLocaleString()} albums` : '…'}</span>
        {activeCount > 0 && <button className={styles.linkButton} onClick={onClear}>Clear {activeCount}</button>}
      </div>

      <Section title="Saved views">
        {savedViews && savedViews.length > 0 ? savedViews.map((v) => (
          <div key={v.id} className={styles.viewRow}>
            <button className={styles.option} onClick={() => onApplyView(v)} title={JSON.stringify(v.query)}>
              <span className={styles.optionLabel}>{v.name}</span>
            </button>
            <button className={styles.iconButton} title="Delete view" onClick={() => onDeleteView(v.id)}>✕</button>
          </div>
        )) : <div className={styles.muted}>No saved views yet</div>}
        <button className={styles.linkButton} onClick={onSaveView} disabled={activeCount === 0 && !query.sort}>
          Save current view…
        </button>
      </Section>

      <Section title="Identification" count={len('state')}>
        <MultiOptions items={facets?.states} labels={STATE_LABEL} isActive={active('state')} onToggle={on('state')} />
      </Section>
      <Section title="Format" count={len('format')}>
        <MultiOptions items={facets?.formats} labels={FORMAT_LABEL} isActive={active('format')} onToggle={on('format')} />
        <div className={styles.subhead}>containers</div>
        <MultiOptions
          items={facets?.containers?.map((c) => ({ ...c, label: c.value.toUpperCase() }))}
          isActive={active('format')}
          onToggle={on('format')}
        />
      </Section>
      <Section title="Decade" count={len('decade')}>
        <MultiOptions items={facets?.decades} isActive={active('decade')} onToggle={on('decade')} />
      </Section>
      <Section title="Genre & style" count={len('genre')}>
        {facets && facets.genres.length > 8 && (
          <input className={styles.filterInput} placeholder="Filter genres…" value={genreQuery} onChange={(e) => setGenreQuery(e.target.value)} />
        )}
        <MultiOptions items={genres} isActive={active('genre')} onToggle={on('genre')} />
      </Section>
      <Section title="Label" count={len('label')} defaultOpen={false}>
        {facets && facets.labels.length > 8 && (
          <input className={styles.filterInput} placeholder="Filter labels…" value={labelQuery} onChange={(e) => setLabelQuery(e.target.value)} />
        )}
        <MultiOptions items={labels} isActive={active('label')} onToggle={on('label')} />
      </Section>
      <Section title="Needs attention" count={len('gap')}>
        <MultiOptions items={facets?.gaps} labels={GAP_LABEL} isActive={active('gap')} onToggle={on('gap')} hideZero={false} />
      </Section>
      <Section title="Collection">
        <SingleOptions items={facets?.owned} labels={OWNED_LABEL} current={query.owned} onPick={(v) => onSet('owned', v)} hideZero={false} />
      </Section>
      <Section title="Reviews & listens">
        <SingleOptions items={facets?.review} labels={REVIEW_LABEL} current={query.review} onPick={(v) => onSet('review', v)} hideZero={false} />
      </Section>
      <Section title="Match kind" defaultOpen={false}>
        <SingleOptions items={facets?.decided} labels={DECIDED_LABEL} current={query.decided} onPick={(v) => onSet('decided', v)} />
      </Section>
    </aside>
  );
}
