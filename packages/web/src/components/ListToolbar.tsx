/**
 * The toolbar over a browsable list (Albums, Artists): the count as plain
 * text on the left, then three embossed icon keys on the right: Sort (a
 * menu of the orders; a sheet on a phone), Filter (with the number of
 * filters on) and Grid/List. One row, about 40px, at every width; the
 * header's search is the page's search (owner, 2026-11-03: "it feels dumb
 * to have two searches").
 */
import type { ReactNode, Ref } from 'react';
import { EmbossIconButton, FilterIcon, GridIcon, ListIcon, Menu, SortIcon, embossClassName } from './ui';
import styles from './ListToolbar.module.css';

export interface SortOption<T extends string> { value: T; label: string }

export interface ListToolbarProps<S extends string> {
  /** "3,287 albums" (empty while it loads) */
  count: ReactNode;
  sort: { value: S; options: SortOption<S>[]; onChange: (next: S) => void; noun: string };
  /** absent on a list without filters */
  filter?: { active: number; open: boolean; onToggle: () => void; ref?: Ref<HTMLButtonElement> } | undefined;
  view: { value: 'grid' | 'list'; onChange: (next: 'grid' | 'list') => void };
}

export function ListToolbar<S extends string>({ count, sort, filter, view }: ListToolbarProps<S>) {
  const current = sort.options.find((o) => o.value === sort.value) ?? sort.options[0];
  const toList = view.value === 'grid';
  return (
    <div className={styles.toolbar}>
      <span className={styles.count} aria-live="polite">{count}</span>
      <div className={styles.keys}>
        <Menu
          label={`Sort ${sort.noun}: ${current?.label ?? ''}`}
          items={sort.options.map((o) => ({ key: o.value, label: o.label, checked: o.value === sort.value, onSelect: () => sort.onChange(o.value) }))}
          triggerClassName={embossClassName('page', styles.key)}
          icon={<SortIcon />}
        />
        {filter && (
          <span className={styles.filter}>
            <EmbossIconButton
              {...(filter.ref ? { ref: filter.ref } : {})}
              label={filter.active ? `Filters, ${filter.active} on` : 'Filters'}
              className={styles.key}
              aria-expanded={filter.open}
              onClick={filter.onToggle}
            >
              <FilterIcon />
            </EmbossIconButton>
            {filter.active > 0 && <span className={styles.badge} aria-hidden="true">{filter.active}</span>}
          </span>
        )}
        <EmbossIconButton label={toList ? 'List view' : 'Grid view'} className={styles.key} onClick={() => view.onChange(toList ? 'list' : 'grid')}>
          {toList ? <ListIcon /> : <GridIcon />}
        </EmbossIconButton>
      </div>
    </div>
  );
}
