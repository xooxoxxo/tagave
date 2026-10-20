import type { Meta, StoryObj } from '@storybook/react-vite';
import { UpdateDownScreen, downProgress } from '../components/update/UpdateDownScreen';
import { PlayerBarView } from '../components/PlayerBar';
import { COVER_SRC } from './fixtures';

/** The player's row as Layout holds it, above the screen. */
function Player() {
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1000 }}>
      <PlayerBarView title="So What" artist="Miles Davis" album="Kind of Blue" coverUrl={COVER_SRC} status="playing" message={null} position={83} duration={562}
        volume={0.8} canPrevious canNext onToggle={() => undefined} onPrevious={() => undefined} onNext={() => undefined} onSeek={() => undefined}
        onVolume={() => undefined} onRetry={() => undefined} onClose={() => undefined} />
    </div>
  );
}

const meta = {
  title: 'Settings/Updates/Down screen',
  component: UpdateDownScreen,
  tags: ['shot-viewport'],
  args: { seed: '0.13.0', version: '0.13.0', progress: 0.62, time: 120 },
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, iframeHeight: 520 },
      description: {
        component:
          'What everyone sees while the app is down for an update (about 20 to 70 seconds of the restart): the page is still loaded, so this is a screen over it. The player keeps its row above it and plays what it has loaded; the screen lifts when the app answers, and the tab switches to the new build at the next moment nothing plays. The version shows only where the run is known (the owner\'s tab elsewhere in the app).',
      },
    },
  },
} satisfies Meta<typeof UpdateDownScreen>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Owner: Story = {};
/** Someone else: the run is not known here, so no version; the glyph grows with the time down. */
export const Listener: Story = { args: { seed: 'tagave', version: null, progress: downProgress(25_000) } };
export const Playing: Story = { args: { seed: 'tagave', version: null, progress: downProgress(25_000) }, render: (args) => <><UpdateDownScreen {...args} /><Player /></> };
/** The lamp moving, full screen (no screenshot: it moves). */
export const Moving: Story = { tags: ['no-shot'], render: (args) => <UpdateDownScreen {...args} time={undefined} /> };
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { seed: 'tagave', version: null, progress: downProgress(25_000) }, render: (args) => <><UpdateDownScreen {...args} /><Player /></> };
