import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReviewsBundle } from '@tagave/shared';
import { CriticScoresRow } from '../components/ReviewsSection';

const bundle: ReviewsBundle = {
  releaseGroupId: '00000000-0000-4000-8000-000000000001', fetchedAt: null, gathering: false, external: [], links: [], clippings: [], own: null, listens: [],
  criticScores: {
    available: true,
    values: [
      { source: { module: 'reviews', ref: null, label: 'CritiqueBrainz' }, aggregate: { score: 8, tier: null, reviewCount: 1 },
        reviews: [{ label: 'CritiqueBrainz', score: 8, scoreRaw: '80/100', url: 'https://critiquebrainz.org/review/1', publishedAt: null }], criticRatings: [], updatedAt: null },
      { source: { module: 'mc', ref: 'l1', label: 'review-gatherer' }, aggregate: { score: 8.7, tier: 'A', reviewCount: 3 },
        reviews: [
          { label: 'Pitchfork (via review-gatherer)', score: 9.1, scoreRaw: '9.1', url: 'https://pitchfork.com/reviews/1', publishedAt: null },
          { label: 'The Quietus (via review-gatherer)', score: null, scoreRaw: 'unscored', url: 'https://thequietus.com/1', publishedAt: null },
        ],
        criticRatings: [{ label: 'Metacritic (via review-gatherer)', score: 8.6, scoreRaw: '86' }], updatedAt: null },
    ],
  },
};

const meta = {
  title: 'Pages/Album › Critic scores',
  component: CriticScoresRow,
  tags: ['no-shot'],
  args: { bundle },
  parameters: {
    docs: {
      description: {
        component: 'The review panel’s critic scores: every source of the album.critic-scores facet, labelled. CritiqueBrainz comes from tagave’s own reviews; a linked app’s reviews say where they came from, for example “Pitchfork (via review-gatherer)”. Scores only, never review text.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 850, padding: 24 }}><Story /></div>],
} satisfies Meta<typeof CriticScoresRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Sources: Story = {};
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };
