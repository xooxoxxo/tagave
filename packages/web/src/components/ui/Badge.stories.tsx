import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from './Badge';
import { Row } from '../../stories/fixtures';

const meta = {
  title: 'Components/Badge',
  component: Badge,
  parameters: { docs: { description: { component: 'A status label. The status is always written in text; the tone only tints it. Not a button and not navigation; for filters use Chip. `statusTone(status)` maps plan and job states to a tone.' } } },
  args: { children: 'Needs review', tone: 'warning' },
  argTypes: { tone: { control: 'inline-radio', options: ['neutral', 'info', 'success', 'warning', 'danger', 'accent'] } },
} satisfies Meta<typeof Badge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Tones: Story = {
  render: () => <Row><Badge>Draft</Badge><Badge tone="success">Applied</Badge><Badge tone="warning">Needs review</Badge><Badge tone="danger">Failed</Badge><Badge tone="info">Processing</Badge><Badge tone="accent">Compilation</Badge></Row>,
};

export const LongText: Story = {
  render: () => <div style={{ width: 160 }}><Badge tone="warning">Four different album-artist tags</Badge></div>,
};

/** sm: a marker in a line of small text, on its baseline (a record's format and copies). */
export const Small: Story = {
  render: () => (
    <p style={{ margin: 0, display: 'flex', alignItems: 'baseline', gap: 14, color: 'var(--ink-3)', fontSize: 'var(--font-size-sm)' }}>
      <Badge size="sm">2×CD</Badge><span>VG+/VG</span><Badge size="sm" tone="warning">2 copies</Badge>
    </p>
  ),
};
