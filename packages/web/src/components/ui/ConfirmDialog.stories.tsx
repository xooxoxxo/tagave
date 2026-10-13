import type { Meta, StoryObj } from '@storybook/react-vite';
import { ConfirmDialog, confirmDialog } from './ConfirmDialog';
import { Button } from './Button';
import { Row } from '../../stories/fixtures';

const meta = {
  title: 'Components/ConfirmDialog',
  tags: ['shot-viewport'],
  component: ConfirmDialog,
  parameters: {
    layout: 'fullscreen',
    docs: { story: { inline: false, iframeHeight: 360 }, description: { component: 'The in-app replacement for the browser’s confirm box: `await confirmDialog({ title, message, confirmLabel, tone })` resolves true or false. A modal <dialog>: the page behind is inert, Tab stays inside, Esc or the backdrop cancels and focus returns to the opener. `tone: "danger"` makes the confirm the danger drop and starts focus on Cancel. `<ConfirmHost />` is mounted once at the root.' } },
  },
  args: { title: 'Apply this tag plan?', message: 'Every write is journalled and can be reverted.', confirmLabel: 'Apply changes', tone: 'primary', onResult: () => undefined },
} satisfies Meta<typeof ConfirmDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Danger: Story = { args: { title: 'Delete this saved view?', message: 'The albums are not affected, only the saved filters.', confirmLabel: 'Delete', tone: 'danger' } };
export const LongMessage: Story = { args: { title: 'Delete 212 applied plans and their journals?', message: 'Plans that can still be reverted hold the old tags Revert puts back. Deleting them makes those tag changes permanent. About 48 MB of journal data is removed. Albums and files are not touched.', confirmLabel: 'Delete them', tone: 'danger' } };

export const FromCode: Story = {
  tags: ['!shot-viewport'],
  parameters: { docs: { description: { story: 'Calling confirmDialog() from an event handler.' } } },
  render: () => <Row>
    <Button variant="secondary" onClick={() => void confirmDialog({ title: 'Apply this tag plan?', message: 'Every write is journalled and can be reverted.', confirmLabel: 'Apply changes' })}>Ask to apply</Button>
    <Button variant="quiet-danger" onClick={() => void confirmDialog({ title: 'Delete this saved view?', confirmLabel: 'Delete', tone: 'danger' })}>Ask to delete</Button>
  </Row>,
};
