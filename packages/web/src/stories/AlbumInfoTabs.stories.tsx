import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReviewsBundle } from '@tagave/shared';
import { ReviewsSection } from '../components/ReviewsSection';
import { AlbumFacts, type AlbumFact } from '../pages/AlbumFacts';
import { AlbumFolders } from '../pages/AlbumFolders';
import menuStyles from '../pages/AlbumMenu.module.css';
import styles from './AlbumInfoTabs.stories.module.css';

/*
 * The album's About and Reviews tabs rendered WHOLE, with the app's own
 * components and CSS, in the frame the app gives them at the story's width.
 * They exist for the screenshot baselines: a row layout that breaks at a
 * phone or side-sheet width shows up as a diff here, not in a bug report.
 */

const RG = '00000000-0000-4000-8000-0000000000a1';
const LIB = '00000000-0000-4000-8000-0000000000b1';

const empty: ReviewsBundle = {
  releaseGroupId: RG, fetchedAt: null, gathering: false, external: [], links: [], clippings: [], own: null, listens: [],
};

const LONG_REVIEW = [
  'A record that rewards patience. The first side drifts, almost too politely, and then **“Hallogallo”** locks into the motorik pulse and never lets go: ten minutes that feel like four.',
  '',
  'What stays with me is how little happens and how much that little carries. The guitar barely changes; the drums barely change; the mix changes everything. Heard on the 2001 remaster, then on an original pressing a friend lent me, and the pressing wins: the low end breathes.',
  '',
  '> Not background music, though it will happily pretend to be.',
].join('\n');

const full: ReviewsBundle = {
  releaseGroupId: RG,
  fetchedAt: '2026-10-12T09:30:00.000Z',
  gathering: false,
  own: {
    id: '00000000-0000-4000-8000-0000000000c1', releaseGroupId: RG, rating: 4.5, bodyMd: LONG_REVIEW,
    favoriteTrackIds: [], tags: [], currentRevision: 3, createdAt: '2026-08-02T10:00:00.000Z', updatedAt: '2026-10-11T21:15:00.000Z',
  },
  listens: [
    { id: '00000000-0000-4000-8000-0000000000d1', releaseGroupId: RG, releaseId: null, releaseTitle: 'Neu! (2001 remaster)', listenedAt: '2026-10-11T20:00:00.000Z', format: 'vinyl', note: 'Late, with headphones; the second side finally clicked', createdAt: '2026-10-11T20:00:00.000Z' },
    { id: '00000000-0000-4000-8000-0000000000d2', releaseGroupId: RG, releaseId: null, releaseTitle: null, listenedAt: '2026-09-28T12:00:00.000Z', format: 'digital', note: null, createdAt: '2026-09-28T12:00:00.000Z' },
    { id: '00000000-0000-4000-8000-0000000000d3', releaseGroupId: RG, releaseId: null, releaseTitle: null, listenedAt: '2026-09-02T12:00:00.000Z', format: 'cd', note: null, createdAt: '2026-09-02T12:00:00.000Z' },
    { id: '00000000-0000-4000-8000-0000000000d4', releaseGroupId: RG, releaseId: null, releaseTitle: null, listenedAt: '2026-08-02T12:00:00.000Z', format: 'stream', note: null, createdAt: '2026-08-02T12:00:00.000Z' },
  ],
  criticScores: {
    available: true,
    values: [
      { source: { module: 'reviews', ref: null, label: 'CritiqueBrainz' }, aggregate: { score: 8, tier: null, reviewCount: 1 },
        reviews: [{ label: 'CritiqueBrainz', outlet: 'CritiqueBrainz', via: null, score: 8, scoreRaw: '80/100', url: 'https://critiquebrainz.org/review/1', publishedAt: null }], criticRatings: [], updatedAt: null },
      { source: { module: 'mc', ref: 'l1', label: 'review-gatherer' }, aggregate: { score: 8.7, tier: 'A', reviewCount: 3 },
        reviews: [
          { label: 'Pitchfork (via review-gatherer)', outlet: 'Pitchfork', via: 'review-gatherer', score: 9.1, scoreRaw: '9.1', url: 'https://pitchfork.com/reviews/1', publishedAt: null },
          { label: 'The Quietus (via review-gatherer)', outlet: 'The Quietus', via: 'review-gatherer', score: null, scoreRaw: 'unscored', url: 'https://thequietus.com/1', publishedAt: null },
        ],
        criticRatings: [{ label: 'Metacritic (via review-gatherer)', outlet: 'Metacritic', via: 'review-gatherer', score: 8.6, scoreRaw: '86' }], updatedAt: null },
    ],
  },
  external: [
    { id: '00000000-0000-4000-8000-0000000000e1', source: 'musicbrainz', sourceId: null, url: 'https://musicbrainz.org/release-group/1', author: null, title: null, bodyText: null, excerpt: '12 votes',
      ratingRaw: 4.25, ratingScale: 5, ratingNormalized: 85, license: 'CC0', language: null, publishedAt: null, fetchedAt: '2026-10-12T09:30:00.000Z', stale: false },
    { id: '00000000-0000-4000-8000-0000000000e2', source: 'discogs', sourceId: null, url: 'https://www.discogs.com/master/1', author: null, title: null, bodyText: null, excerpt: '311 ratings',
      ratingRaw: 4.31, ratingScale: 5, ratingNormalized: 86, license: 'Discogs data', language: null, publishedAt: null, fetchedAt: '2026-10-12T09:30:00.000Z', stale: false },
    { id: '00000000-0000-4000-8000-0000000000e3', source: 'critiquebrainz', sourceId: null, url: 'https://critiquebrainz.org/review/1', author: 'moondog', title: 'Motorik before it had a name', bodyText: 'The template for half of what came after. Dinger and Rother strip rock down to the pulse and the drone, and the result still sounds like the road opening up ahead.',
      excerpt: null, ratingRaw: 4, ratingScale: 5, ratingNormalized: 80, license: 'CC BY-SA 3.0', language: 'en', publishedAt: '2019-04-03T00:00:00.000Z', fetchedAt: '2026-10-12T09:30:00.000Z', stale: false },
    { id: '00000000-0000-4000-8000-0000000000e4', source: 'wikipedia', sourceId: null, url: 'https://en.wikipedia.org/wiki/Neu!_(album)', author: null, title: null,
      bodyText: 'Neu! is the debut studio album by the German krautrock band Neu!, released in 1972.\n\nIt was recorded in December 1971 at Windrose-Dumont-Time Studios in Hamburg with producer Conny Plank.',
      excerpt: null, ratingRaw: null, ratingScale: null, ratingNormalized: null, license: 'CC BY-SA 4.0', language: 'en', publishedAt: null, fetchedAt: '2026-10-12T09:30:00.000Z', stale: false },
  ],
  links: [
    { source: 'allmusic', label: 'AllMusic', url: 'https://www.allmusic.com/album/1', discoveredVia: 'wikidata' },
    { source: 'rateyourmusic', label: 'Rate Your Music', url: 'https://rateyourmusic.com/release/1', discoveredVia: 'mb_relationship' },
    { source: 'pitchfork', label: 'Pitchfork', url: 'https://pitchfork.com/search?q=neu', discoveredVia: 'template' },
  ],
  clippings: [
    { id: '00000000-0000-4000-8000-0000000000f1', releaseGroupId: RG, url: 'https://thewire.co.uk/1', sourceLabel: 'The Wire', scoreRaw: null, note: 'Still the most forward-looking record of 1972.', createdAt: '2026-09-30T08:00:00.000Z' },
  ],
};

const aboutFacts: AlbumFact[] = [
  ['Released', '1972'],
  ['Label', 'Brain · brain 1004'],
  ['Country', 'Germany'],
  ['Tracks', '6 tracks · 46 min'],
  ['Format', 'FLAC 16-bit 44.1 kHz'],
  ['Genres & styles', 'Krautrock, Experimental, Electronic, Ambient, Motorik'],
  ['Local folder', <AlbumFolders folders={[{ path: 'Neu!/1972 - Neu! [Brain 1004, 2001 remaster]', scanRootId: 'r1', link: 'smb://nas/music/Neu!/1972 - Neu!' }]} />],
];

/** Reviews data the way the app has it: already in the query cache, nothing fetched. */
function WithReviews({ bundle, children }: { bundle: ReviewsBundle; children: ReactNode }) {
  const [client] = useState(() => {
    const c = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } });
    c.setQueryData(['reviews', RG], bundle);
    return c;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The info drawer's panel (AlbumMenu.module.css), sized like the bottom or side sheet. */
function Drawer({ children }: { children: ReactNode }) {
  return <div className={`${styles.frame} ${menuStyles.sheet}`}><div className={menuStyles.infoPanel}>{children}</div></div>;
}

type Args = { tab: 'about' | 'reviews'; data: 'empty' | 'full'; place: 'drawer' | 'page' };

function InfoTab({ tab, data, place }: Args) {
  const body = tab === 'about'
    ? <AlbumFacts facts={aboutFacts} source={{ discogs: true, mbid: 'b8c0c3a4-6f1e-4b4f-9a3e-1f2d3c4b5a69' }} />
    : <WithReviews bundle={data === 'full' ? full : empty}><ReviewsSection libraryId={LIB} releaseGroupId={RG} /></WithReviews>;
  return place === 'page' ? <div className={styles.page}>{body}</div> : <Drawer>{body}</Drawer>;
}

const meta = {
  title: 'Pages/Album › Info tabs',
  component: InfoTab,
  tags: ['shot-full'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'The album’s About and Reviews tabs, whole, in the frame the app gives them: the bottom drawer on a phone or tablet, the 440px side sheet on a desktop, and the page’s own About tab. A Reviews row is a label, its value and one control: three columns with room, the control under the value when the frame is narrower, and label over value in a phone-width frame (container queries on the card). About’s facts stack on a phone.',
      },
    },
  },
  args: { tab: 'reviews', data: 'empty', place: 'drawer' },
} satisfies Meta<typeof InfoTab>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone: Pick<Story, 'tags' | 'globals'> = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };

export const ReviewsEmptyPhone: Story = { ...phone, name: 'Reviews · empty · phone' };
export const ReviewsFullPhone: Story = { ...phone, name: 'Reviews · full · phone', args: { data: 'full' } };
export const ReviewsEmptyDesktop: Story = { name: 'Reviews · empty · desktop side sheet' };
export const ReviewsFullDesktop: Story = { name: 'Reviews · full · desktop side sheet', args: { data: 'full' } };
export const ReviewsFullPage: Story = { name: 'Reviews · full · album page', args: { data: 'full', place: 'page' } };
export const AboutPhone: Story = { ...phone, name: 'About · phone', args: { tab: 'about' } };
export const AboutDesktop: Story = { name: 'About · desktop side sheet', args: { tab: 'about' } };
