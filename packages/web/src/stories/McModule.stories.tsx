import type { Meta, StoryObj } from '@storybook/react-vite';
import { McModuleRow } from '../pages/SettingsModulesPage';

const meta = {
  title: 'Settings/Modules › Music Connections',
  component: McModuleRow,
  tags: ['no-shot'],
  args: { view: { enabled: true, links: 2, landed: 412, fills: 3 }, onTurnOn: () => undefined, onTurnOff: () => undefined },
  parameters: {
    docs: {
      description: {
        component: 'Music Connections in Settings › Modules: the same row as the player, a setting in place of a container. Off stops its jobs and hides its pages and data from linked apps, and keeps everything; Turn off can also delete its data.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 850, padding: 24 }}><Story /></div>],
} satisfies Meta<typeof McModuleRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const On: Story = {};
export const Off: Story = { args: { view: { enabled: false, links: 0, landed: 0, fills: 0 } } };
export const Refused: Story = { args: { error: 'Confirm it is you first: this action needs a sign-in or a re-verification from the last five minutes.' } };
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };
