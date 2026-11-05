import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AlbumSplitView, SplitPlan } from '@tagave/shared';
import { TagSheet, type TagRowId } from '../components/TagSheet';
import { albumSplitKey } from '../hooks/useAlbumSplit';
import { scanRootsKey } from '../hooks/useLibrary';
import { namingKey } from '../hooks/useNaming';
import { setCurrentRole } from '../hooks/usePermissions';

const LIB = 'lib';
const ID = '22222222-2222-4222-8222-222222222222';
const RATE = 44_100;
const TITLES = ['Airbag', 'Paranoid Android', 'Subterranean Homesick Alien', 'Exit Music (For a Film)', 'Let Down', 'Karma Police', 'Fitter Happier', 'Electioneering', 'Climbing Up the Walls', 'No Surprises', 'Lucky'];

const album = (over: Record<string, unknown> = {}) => ({
  id: ID, state: 'matched', title: 'OK Computer', artistCredit: 'Radiohead', trackCount: 1, tracks: [], candidates: [],
  identifyRequest: null,
  release: { title: 'OK Computer', date: '1997-05-21', country: 'GB', labels: [{ name: 'Parlophone' }] },
  ...over,
});

const PLAN: SplitPlan = {
  sampleRate: RATE, channels: 2, bitsPerSample: 16, totalSamples: RATE * 2990,
  tracks: TITLES.map((title, i) => ({
    n: i + 1, disc: 1, position: i + 1, title, startSample: RATE * 270 * i, endSample: i === 10 ? RATE * 2990 : RATE * 270 * (i + 1),
    fileName: `${String(i + 1).padStart(2, '0')} - ${title}.flac`, shiftMs: i === 0 ? null : 300, confidence: i === 0 ? null : 'high',
  })),
};
const NO_SPLIT: AlbumSplitView = { split: null, eligible: false, writable: true, localTrackId: null, tracks: null };
const ONE_FILE: AlbumSplitView = {
  split: { id: 's1', state: 'ready', plan: PLAN, outputs: null, error: null, createdAt: '2026-11-05T10:00:00.000Z', finishedAt: null },
  eligible: true, writable: true, localTrackId: 't1', tracks: 11,
};

function Cache({ children, albumData, split }: { children: ReactNode; albumData: unknown; split: AlbumSplitView }) {
  const [client] = useState(() => {
    setCurrentRole('owner');
    const c = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnMount: false } } });
    c.setQueryData(['album', ID], albumData);
    c.setQueryData(albumSplitKey(LIB, ID), split);
    c.setQueryData(['library-settings', LIB], { tagWritesEnabled: true, tagPolicy: { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' } });
    c.setQueryData(scanRootsKey(LIB), [{ id: 'r', writable: true, validationStatus: 'ok' }]);
    c.setQueryData(namingKey(LIB), { saved: true });
    c.setQueryData(['tag-plans', LIB, 'accepts-albums'], { items: [], total: 0, limit: 200, offset: 0 });
    return c;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const sheet = (opts: { albumData?: unknown; split?: AlbumSplitView; rows?: TagRowId[]; side?: 'bottom' | 'right' } = {}) => (
  <Cache albumData={opts.albumData ?? album()} split={opts.split ?? NO_SPLIT}>
    <TagSheet
      open
      onOpenChange={() => undefined}
      libraryId={LIB}
      albums={{ ids: [ID], labels: { [ID]: 'Radiohead — OK Computer' } }}
      side={opts.side ?? 'right'}
      {...(opts.rows ? { initialRows: opts.rows } : {})}
    />
  </Cache>
);

const meta = {
  title: 'Components/Tag sheet',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Tag: one sheet that already holds the defaults (a new plan, the matched release, the library\'s tag settings). Preview creates the plan and opens its page. Every other choice is a collapsed row with its value; without a match the button picks a release; an album in one file says how many tracks the plan splits it into first.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Matched: Story = { name: 'With a match', tags: ['shot-viewport'], render: () => sheet() };
export const NoMatch: Story = {
  name: 'No match',
  tags: ['shot-viewport'],
  render: () => sheet({ albumData: album({ state: 'review', release: null }) }),
};
export const OneFile: Story = { name: 'One file · split first', tags: ['shot-viewport'], render: () => sheet({ split: ONE_FILE }) };
export const RowsOpen: Story = { name: 'Rows open', tags: ['shot-viewport'], render: () => sheet({ split: ONE_FILE, rows: ['split', 'fields', 'name'] }) };
export const Phone: Story = { name: 'With a match · Phone', tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => sheet({ side: 'bottom' }) };
export const OneFilePhone: Story = { name: 'One file · Phone', tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => sheet({ split: ONE_FILE, side: 'bottom' }) };
export const NoMatchPhone: Story = {
  name: 'No match · Phone',
  tags: ['phone'],
  globals: { viewport: { value: 'phone' } },
  render: () => sheet({ albumData: album({ state: 'review', release: null }), side: 'bottom' }),
};
export const RowsOpenPhone: Story = { name: 'Rows open · Phone', tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => sheet({ split: ONE_FILE, rows: ['split', 'fields', 'name'], side: 'bottom' }) };
