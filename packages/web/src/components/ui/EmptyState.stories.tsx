import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmptyState } from './EmptyState';
import { Button } from './Button';

const meta = {
  title: 'Components/EmptyState',
  component: EmptyState,
  parameters: { docs: { description: { component: 'What a list or page shows when it has nothing: what is missing and, when there is one, the one action that fixes it.' } } },
  args: { title: 'No albums match', text: 'Clear a filter or search for another artist.' },
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithAction: Story = { args: { action: <Button variant="secondary">Clear filters</Button> } };
export const TitleOnly: Story = { args: { text: undefined } };
export const LongText: Story = { args: { title: 'Nothing has been scanned yet', text: 'Add a folder in Settings › Libraries. Scanning reads tags and artwork only; nothing is written to your files until you apply a plan.', action: <Button>Add a folder</Button> } };
