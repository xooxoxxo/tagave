import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Collapse } from './Collapse';
import { Button } from './Button';
import { Stack } from '../../stories/fixtures';

const meta = {
  title: 'Components/Collapse',
  component: Collapse,
  parameters: { docs: { description: { component: 'Shows and hides a block with a height animation that never measures (a 0fr to 1fr grid row), so content below moves smoothly. Closed content is inert. Use it for disclosure rows and details under a list item; the trigger owns aria-expanded and aria-controls.' } } },
  args: { open: true, children: <p style={{ margin: 0 }}>Twelve tracks share one folder but carry four different album-artist tags.</p> },
} satisfies Meta<typeof Collapse>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};
export const Closed: Story = { args: { open: false } };

function Toggle() {
  const [open, setOpen] = useState(false);
  return <Stack>
    <Button variant="secondary" aria-expanded={open} aria-controls="collapse-demo" onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Show details'}</Button>
    <Collapse id="collapse-demo" open={open}><p style={{ margin: 0 }}>Every write is journalled and can be reverted from Tag changes.</p></Collapse>
    <p style={{ margin: 0, color: 'var(--ink-2)' }}>Content below moves with it.</p>
  </Stack>;
}

export const Interactive: Story = { render: () => <Toggle /> };
