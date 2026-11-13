/**
 * Settings › Appearance › Sidebar in the app's desktop frame: Always (the
 * sidebar in the row), and Auto-hide: hidden (the page takes the whole
 * width, a faint accent mark on the left edge), revealed (over the page on
 * glass between the page's sticky header and the player bar, nothing in the
 * page moved) and pinned (in the row again, with
 * Unpin at the foot of the links). 1440 and 1024 wide; at 390 a phone keeps
 * its own bar whatever the preference says. The frame runs the real
 * behaviour: move the pointer to the left edge, Tab in, Escape, Pin.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PlayerBarView } from '../components/PlayerBar';
import { CoverArt, PageShell } from '../components/ui';
import { COVERS, COVER_KEYS } from './adaptiveCovers';
import { DesktopFrame } from './DesktopFrame';
import s from './DesktopFrame.module.css';

type Shown = 'always' | 'hidden' | 'revealed' | 'pinned';
interface Args { shown: Shown }

const noop = () => undefined;
const TRACK = COVERS.moody;

function Albums() {
  return (
    <PageShell title="Albums" sticky>
      <div className={s.grid}>
        {[...COVER_KEYS, ...COVER_KEYS].map((k, i) => (
          <div key={i} className={s.album}>
            <CoverArt src={COVERS[k].src} title={COVERS[k].album} loading="eager" />
            <a href="#" onClick={(e) => e.preventDefault()}>{COVERS[k].album}</a>
            <span>{COVERS[k].artist}</span>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

function InTheApp({ shown }: Args) {
  const dock = (
    <PlayerBarView
      title={TRACK.title} artist={TRACK.artist} album={TRACK.album} coverUrl={TRACK.src}
      status="paused" position={96} duration={321} volume={0.8}
      canPrevious canNext empty={false}
      onToggle={noop} onPrevious={noop} onNext={noop} onSeek={noop} onVolume={noop} onRetry={noop} onQueue={noop}
    />
  );
  return (
    <DesktopFrame dock={dock} sidebar={shown === 'always' ? 'always' : 'autoHide'} revealed={shown === 'revealed'} pinned={shown === 'pinned'}>
      <Albums />
    </DesktopFrame>
  );
}

const meta = {
  title: 'Components/Sidebar/Auto-hide',
  component: InTheApp,
  tags: ['!autodocs'],
  args: { shown: 'always' },
  argTypes: { shown: { control: 'inline-radio', options: ['always', 'hidden', 'revealed', 'pinned'] } },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof InTheApp>;
export default meta;
type Story = StoryObj<typeof meta>;

const wide = ['viewport-1440'];
const narrow = ['viewport-1024'];

export const Always: Story = { tags: wide };
export const Hidden: Story = { name: 'Auto-hide, hidden', tags: wide, args: { shown: 'hidden' } };
export const Revealed: Story = { name: 'Auto-hide, revealed', tags: wide, args: { shown: 'revealed' } };
export const Pinned: Story = { name: 'Auto-hide, pinned', tags: wide, args: { shown: 'pinned' } };
export const Always1024: Story = { name: 'Always, 1024', tags: narrow };
export const Hidden1024: Story = { name: 'Auto-hide, hidden, 1024', tags: narrow, args: { shown: 'hidden' } };
export const Revealed1024: Story = { name: 'Auto-hide, revealed, 1024', tags: narrow, args: { shown: 'revealed' } };
export const Pinned1024: Story = { name: 'Auto-hide, pinned, 1024', tags: narrow, args: { shown: 'pinned' } };
/** A phone with Auto-hide chosen: its own bar, no mark, no pin, no sidebar over the page. */
export const PhoneAutoHide: Story = { name: 'Auto-hide on a phone', tags: ['phone'], args: { shown: 'revealed' } };
