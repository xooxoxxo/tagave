import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';

/** Hover the trigger (the tooltip opens on pointer enter and on keyboard focus). */
const hover = async (canvasElement: HTMLElement) => { await userEvent.hover((await within(canvasElement).findAllByRole('button'))[0]!); };
import { Tooltip } from './Tooltip';
import { Button, IconButton } from './Button';
import { EditIcon, Row } from '../../stories/fixtures';

const meta = {
  title: 'Components/Tooltip',
  component: Tooltip,
  parameters: { layout: 'centered', docs: { description: { component: 'Short supplementary text on hover and keyboard focus, wired with aria-describedby; Escape, blur or leaving closes it. Never the only place important information lives, and never on a disabled control. An IconButton already has a native title from its label; add a Tooltip only when there is more to say.' } } },
  args: { content: 'Restores every file in this plan to its journalled tags.', side: 'top', children: <Button variant="secondary">Revert plan</Button> },
} satisfies Meta<typeof Tooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = {
  tags: ['shot-padded'],
  play: async ({ canvasElement }) => { await userEvent.tab(); await hover(canvasElement); },
};

export const Bottom: Story = {
  args: { side: 'bottom', content: 'Edit the tags of this file', children: <IconButton label="Edit"><EditIcon /></IconButton> },
  tags: ['shot-padded'],
  play: async ({ canvasElement }) => { await userEvent.tab(); await hover(canvasElement); },
};

export const LongContent: Story = {
  args: { content: 'Twelve tracks share one folder but carry four different album-artist tags. Revert puts back the tags each file had before the plan was applied.' },
  tags: ['shot-padded'],
  play: async ({ canvasElement }) => { await userEvent.tab(); await hover(canvasElement); },
};

export const Several: Story = {
  render: () => <Row><Tooltip content="Above"><Button variant="secondary">Top</Button></Tooltip><Tooltip content="Below" side="bottom"><Button variant="secondary">Bottom</Button></Tooltip></Row>,
};
