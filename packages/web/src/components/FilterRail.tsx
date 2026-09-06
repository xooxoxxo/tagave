/**
 * Album grid filter rail (spec BRW-1, §14.2): one section per dimension with
 * facet counts over the current result set, single-select per dimension,
 * plus saved views. Every choice is written to the URL by the page.
 */
import { useState } from 'react';
import type { AlbumFacets, AlbumsQuery, SavedView } from '@liner/shared';
import styles from './FilterRail.module.css';

type Patch = Partial<Record<keyof AlbumsQuery, string | number | undefined>>;

interface FilterRailProps {
  query: AlbumsQuery;
  facets: AlbumFacets | undefined;
  savedViews: SavedView[] | undefined;
  activeCount: number;
  onPatch: (patch: Patch) => void;
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

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={styles.section}>
      <button className={styles.sectionHead} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>{title}</span>
        <span className={styles.chevron}>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className={styles.options}>{children}</div>}
    </section>
  );
}

function Options({ items, labels, current, onPick, hideZero = true }: {
  items: Array<{ value: string; label?: string | undefined; count: number }> | undefined;
  labels?: Record<string, string>;
  current: string | undefined;
  onPick: (value: string | undefined) => void;
  hideZero?: boolean;
}) {
  if (!items) return <div className={styles.muted}>…</div>;
  const visible = items.filter((i) => !hideZero || i.count > 0 || i.value === current);
  if (visible.length === 0) return <div className={styles.muted}>none</div>;
  return (
    <>
      {visible.map((i) => {
        const active = current === i.value;
        return (
          <button
            key={i.value}
            className={active ? styles.optionActive : styles.option}
            onClick={() => onPick(active ? undefined : i.value)}
            title={i.label ?? labels?.[i.value] ?? i.value}
          >
            <span className={styles.optionLabel}>{i.label ?? labels?.[i.value] ?? i.value}</span>
            <span className={styles.count}>{i.count.toLocaleString()}</span>
          </button>
        );
      })}
    </>
  );
}

export function FilterRail({ query, facets, savedViews, activeCount, onPatch, onClear, onApplyView, onSaveView, onDeleteView }: FilterRailProps) {
  const [genreQuery, setGenreQuery] = useState('');
  const genres = facets?.genres.filter((g) => !genreQuery || g.value.toLowerCase().includes(genreQuery.toLowerCase()));

  return (
    <aside className={styles.rail}>
      <div className={styles.railHead}>
        <span className={styles.total}>{facets ? `${facets.total.toLocaleString()} albums` : '…'}</span>
        {activeCount > 0 && (
          <button className={styles.linkButton} onClick={onClear}>Clear {activeCount}</button>
        )}
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

      <Section title="Identification">
        <Options items={facets?.states} labels={STATE_LABEL} current={query.state} onPick={(v) => onPatch({ state: v })} />
      </Section>
      <Section title="Format">
        <Options items={facets?.formats} labels={FORMAT_LABEL} current={query.format} onPick={(v) => onPatch({ format: v })} />
        <div className={styles.subhead}>containers</div>
        <Options items={facets?.containers?.map((c) => ({ ...c, label: c.value.toUpperCase() }))} current={query.format} onPick={(v) => onPatch({ format: v })} />
      </Section>
      <Section title="Decade">
        <Options items={facets?.decades} current={query.decade !== undefined ? String(query.decade) : undefined} onPick={(v) => onPatch({ decade: v ? Number(v) : undefined })} />
      </Section>
      <Section title="Genre & style">
        {facets && facets.genres.length > 8 && (
          <input className={styles.filterInput} placeholder="Filter genres…" value={genreQuery} onChange={(e) => setGenreQuery(e.target.value)} />
        )}
        <Options items={genres} current={query.genre} onPick={(v) => onPatch({ genre: v })} />
      </Section>
      <Section title="Label" defaultOpen={false}>
        <Options items={facets?.labels} current={query.label} onPick={(v) => onPatch({ label: v })} />
      </Section>
      <Section title="Collection">
        <Options items={facets?.owned} labels={OWNED_LABEL} current={query.owned} onPick={(v) => onPatch({ owned: v })} hideZero={false} />
      </Section>
      <Section title="Reviews & listens">
        <Options items={facets?.review} labels={REVIEW_LABEL} current={query.review} onPick={(v) => onPatch({ review: v })} hideZero={false} />
      </Section>
      <Section title="Needs attention">
        <Options items={facets?.gaps} labels={GAP_LABEL} current={query.gap} onPick={(v) => onPatch({ gap: v })} hideZero={false} />
      </Section>
      <Section title="Match kind" defaultOpen={false}>
        <Options items={facets?.decided} labels={DECIDED_LABEL} current={query.decided} onPick={(v) => onPatch({ decided: v })} />
      </Section>
    </aside>
  );
}
