/**
 * Small pieces of the Review matches screen: the provider mark that is also
 * the link to the release, and the match meter (bar, percent, word).
 */
import { matchStrength } from '@tagave/shared';
import styles from './review.module.css';

export interface EditionLinkSource {
  provider: string;
  releaseMbid: string | null;
  discogsReleaseId: number | null;
}

/**
 * The page of record for an edition: MusicBrainz for a MusicBrainz release,
 * Discogs for a Discogs one. One link, never both side by side; a
 * MusicBrainz release also bridged to Discogs still opens on MusicBrainz.
 */
export function editionLink(c: EditionLinkSource): { provider: 'musicbrainz' | 'discogs'; url: string } | null {
  const discogs = c.provider === 'discogs';
  if (discogs && c.discogsReleaseId) return { provider: 'discogs', url: `https://www.discogs.com/release/${c.discogsReleaseId}` };
  if (c.releaseMbid) return { provider: 'musicbrainz', url: `https://musicbrainz.org/release/${c.releaseMbid}` };
  if (c.discogsReleaseId) return { provider: 'discogs', url: `https://www.discogs.com/release/${c.discogsReleaseId}` };
  return null;
}

/** Two halves in the MusicBrainz colours: an evocative mark, not the logo. */
function MusicBrainzMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M11 3 3 7.5v9L11 21V3Z" fill="#ba478f" />
      <path d="m13 3 8 4.5v9L13 21V3Z" fill="#eb743b" />
    </svg>
  );
}

/** A record: grooves and a label hole, in the ink colour. */
function DiscogsMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="9" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="5" strokeWidth="1.2" opacity=".6" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

const PROVIDER_LABEL = { musicbrainz: 'MusicBrainz', discogs: 'Discogs' } as const;

/** The provider mark as the link to the release (or a plain mark when there is no page). */
export function SourceIcon({ edition }: { edition: EditionLinkSource }) {
  const link = editionLink(edition);
  const provider = link?.provider ?? (edition.provider === 'discogs' ? 'discogs' : 'musicbrainz');
  const mark = provider === 'discogs' ? <DiscogsMark /> : <MusicBrainzMark />;
  if (!link) {
    return <span className={styles.source} role="img" aria-label={PROVIDER_LABEL[provider]} title={PROVIDER_LABEL[provider]}>{mark}</span>;
  }
  const label = `Open on ${PROVIDER_LABEL[provider]}`;
  return (
    <a
      className={styles.source}
      href={link.url}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
      onClick={(e) => e.stopPropagation()}
    >
      {mark}
    </a>
  );
}

const STRENGTH_CLASS = { Strong: styles.strong, Good: styles.good, Weak: styles.weak } as const;

/** A short bar, the percent and a word: Strong ≥ 90, Good ≥ 75, Weak below. */
export function MatchMeter({ percent }: { percent: number }) {
  const word = matchStrength(percent);
  return (
    <span className={`${styles.meter} ${STRENGTH_CLASS[word] ?? ''}`} title={`${percent}% match`}>
      <span className={styles.meterBar} aria-hidden="true"><i style={{ width: `${percent}%` }} /></span>
      <span className={styles.meterPct}>{percent}%</span>
      <span className={styles.meterWord}>{word}</span>
    </span>
  );
}

/** Uppercase note for a MusicBrainz status other than Official (PROMOTION, BOOTLEG …). */
export function StatusTag({ status }: { status: string }) {
  return <span className={styles.tag}>{status}</span>;
}
