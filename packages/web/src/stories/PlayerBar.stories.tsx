import type { Meta, StoryObj } from '@storybook/react-vite';
import { PlayerBarView } from '../components/PlayerBar';
import { COVER_SRC } from './fixtures';

const meta = {
  title: 'Components/Player bar',
  component: PlayerBarView,
  // No screenshot baselines yet: new stories have none, and the story test
  // fails a missing baseline. Render them on the CI runner (DESIGN.md) and
  // drop `no-shot`. The axe scan still runs on every story.
  tags: ['no-shot'],
  args: {
    title: 'So What',
    artist: 'Miles Davis',
    album: 'Kind of Blue',
    coverUrl: COVER_SRC,
    status: 'playing',
    message: null,
    position: 83,
    duration: 296,
    volume: 0.8,
    canPrevious: true,
    canNext: true,
    onToggle: () => undefined,
    onPrevious: () => undefined,
    onNext: () => undefined,
    onSeek: () => undefined,
    onVolume: () => undefined,
    onRetry: () => undefined,
    onClose: () => undefined,
  },
  argTypes: {
    status: { control: 'inline-radio', options: ['loading', 'playing', 'paused', 'buffering', 'error'] },
    position: { control: { type: 'range', min: 0, max: 296, step: 1 } },
    volume: { control: { type: 'range', min: 0, max: 1, step: 0.05 } },
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, iframeHeight: 160 },
      description: {
        component: 'The player of the opt-in player module (Settings › Playback): what is playing, previous / play-pause / next, a seek bar with the elapsed and total time, the volume on a desktop with a mouse, and close (stops and clears the queue). It takes its own row at the foot of the content column, so the page scrolls above it and nothing is covered; on a phone it spans the screen and clears the home indicator. Loading and buffering put a quiet spinner in the play key; an error says what happened with Retry. `PlayerBarView` is the bar alone, driven by props; `PlayerBar` (mounted once in Layout) connects it to the audio engine and appears only while a queue exists and a player is installed. Space toggles play and pause outside fields and buttons; media keys go through the Media Session.',
      },
    },
  },
  decorators: [(Story) => <div style={{ paddingTop: 48 }}><Story /></div>],
} satisfies Meta<typeof PlayerBarView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playing: Story = {};
export const Paused: Story = { args: { status: 'paused' } };
export const Loading: Story = { args: { status: 'loading', position: 0 } };
export const Buffering: Story = { args: { status: 'buffering', position: 141 } };
export const ErrorState: Story = { name: 'Error', args: { status: 'error', message: 'Too many tracks are playing on your account right now. Stop one, then try again.' } };
export const LongTitles: Story = {
  args: {
    title: 'Concerto for Two Violins, Strings and Continuo in D minor, BWV 1043: I. Vivace (live at the Philharmonie, second night)',
    artist: 'Academy of St Martin in the Fields, Sir Neville Marriner, Iona Brown and Malcolm Latchem',
    album: 'The Complete Brandenburg Concertos and Violin Concertos (Remastered Deluxe Edition)',
    position: 3723,
    duration: 4321,
  },
};
export const NoCover: Story = { args: { coverUrl: null } };
export const AtTheEnd: Story = { args: { canNext: false, position: 296 } };
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };
export const PhoneError: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { status: 'error', message: 'Not on the player yet — its first scan is at 34\u202f%.' } };
