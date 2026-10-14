import type { Meta, StoryObj } from '@storybook/react-vite';
import { NewBuildNoticeView } from '../components/NewBuildNotice';

const meta = {
  title: 'Components/New build notice',
  component: NewBuildNoticeView,
  // No screenshot baseline yet: render one on the CI runner (DESIGN.md) and drop `no-shot`.
  tags: ['no-shot'],
  args: { onReload: () => undefined, onDismiss: () => undefined },
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, iframeHeight: 200 },
      description: {
        component: 'Shown when the server runs a newer build than the open tab (after an update). It never reloads by itself, so nothing typed is lost; Reload loads the new build, × hides it for that build. Mounted once at the root as `<NewBuildNotice />`, which watches for the new build (services/buildCheck.ts).',
      },
    },
  },
} satisfies Meta<typeof NewBuildNoticeView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Shown: Story = {};
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };
