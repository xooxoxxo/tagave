/**
 * Listen (the listen-links module): one control that sends the person to
 * the album on the streaming platforms they picked in Settings › Listen
 * elsewhere. One platform: a direct link with its name ("Qobuz"). Several: a
 * "Listen" key that opens a menu of them (a sheet from the bottom on a
 * phone), in the person's order. Both are the embossed icon with a word
 * beside it. A link that is not the album itself says so: "Artist page" or
 * "Search". Links open in a new tab, or the platform's app on a phone.
 */
import { createContext } from 'react';
import type { ListenLinkView } from '@tagave/shared';
import { ListenIcon, Menu, embossClassName } from './ui';
import styles from './ListenControl.module.css';

/** The artist page's missing albums' links, by release group id (null: none to show). */
export const MissingListenLinks = createContext<Readonly<Record<string, ListenLinkView[]>> | null>(null);

export const LISTEN_KIND_LABEL: Record<ListenLinkView['kind'], string | null> = { exact: null, artist: 'Artist page', search: 'Search' };

/** "Listen on Qobuz", "Listen on Qobuz (search)": the link's name for screen readers and its tooltip. */
export function listenLabel(l: ListenLinkView): string {
  const kind = LISTEN_KIND_LABEL[l.kind];
  return `Listen on ${l.name}${kind ? ` (${kind.toLowerCase()})` : ''}`;
}

export function ListenControl({ links, className }: { links: readonly ListenLinkView[]; className?: string | undefined }) {
  if (links.length === 0) return null;
  const cls = embossClassName('page', [styles.control, className].filter(Boolean).join(' '));
  if (links.length === 1) {
    const l = links[0]!;
    const kind = LISTEN_KIND_LABEL[l.kind];
    return (
      <a className={cls} href={l.url} target="_blank" rel="noopener noreferrer" aria-label={listenLabel(l)} title={listenLabel(l)} data-listen={l.kind}>
        <ListenIcon />
        <span className={styles.word}>{l.name}</span>
        {kind && <span className={styles.kind}>{kind}</span>}
      </a>
    );
  }
  return (
    <Menu
      label="Listen"
      heading="Listen on"
      className={styles.anchor ?? ''}
      triggerClassName={cls}
      icon={<><ListenIcon /><span className={styles.word} aria-hidden="true">Listen</span></>}
      items={links.map((l) => {
        const kind = LISTEN_KIND_LABEL[l.kind];
        return { key: l.platform, label: l.name, href: l.url, ...(kind ? { hint: kind } : {}) };
      })}
    />
  );
}
