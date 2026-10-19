/**
 * The album's About facts: a label and its value per row ("Released",
 * "Genres & styles", "Local folder" with its actions). Side by side with
 * room, stacked on a phone (AlbumDetailPage.module.css `.facts`). Shared by
 * the page's About tab and the Album info drawer, and rendered whole in
 * Storybook so a layout change shows up in the screenshot baselines.
 */
import type { ReactNode } from 'react';
import styles from './AlbumDetailPage.module.css';

export type AlbumFact = [label: string, value: ReactNode];

export function AlbumFacts({ facts }: { facts: AlbumFact[] }) {
  return (
    <dl className={styles.facts}>
      {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}
