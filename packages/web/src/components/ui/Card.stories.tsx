import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card, StatCard, Surface } from './Card';
import { Button } from './Button';
import { Stack } from '../../stories/fixtures';

const meta = {
  title: 'Components/Card',
  component: Card,
  parameters: { docs: { description: { component: 'Card groups related content on an opaque surface with an optional title and actions. When a separate surface is not needed, use headings and page spacing instead. StatCard shows one number; Surface is a bare card, inset well or glass layer (glass is for floating layers only: popovers, sticky bars, toasts).' } } },
  args: { title: 'Grouped content', children: 'A card groups related information.', padded: true },
} satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { render: (args) => <div style={{ maxWidth: 520 }}><Card {...args} /></div> };

export const WithActions: Story = {
  render: () => <div style={{ maxWidth: 520 }}><Card title="Library" actions={<Button size="sm" variant="secondary">Edit</Button>}><p>1,284 albums in 3 folders. Last scanned an hour ago.</p></Card></div>,
};

export const Unpadded: Story = { args: { title: undefined, padded: false, children: <p style={{ margin: 0, padding: 12 }}>Content that brings its own padding (a table).</p> }, render: (args) => <div style={{ maxWidth: 520 }}><Card {...args} /></div> };

export const LongTitle: Story = {
  render: () => <div style={{ width: 320 }}><Card title="Various Artists — Café del Mar, Volumen Siete (Remastered Deluxe Edition)" actions={<Button size="sm" variant="secondary">Edit</Button>}><p>Long titles wrap; actions stay put.</p></Card></div>,
};

export const StatCards: Story = {
  render: () => <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, maxWidth: 900 }}>
    <StatCard label="Albums" value="1,284" hint="12 added this week" />
    <StatCard label="Need review" value="37" tone="warning" />
    <StatCard label="Applied plans" value="212" tone="success" />
    <StatCard label="Failed" value="2" tone="danger" />
    <StatCard label="Identifying" value="18" tone="info" />
  </div>,
};

export const Surfaces: Story = {
  render: () => <Stack width={560}>
    <Surface variant="card" style={{ width: '100%' }}>card: opaque content surface</Surface>
    <Surface variant="inset" style={{ width: '100%' }}>inset: a recessed well</Surface>
    <Surface variant="glass" style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, borderRadius: 'var(--r-pill)', padding: '10px 10px 10px 24px' }}><span>Plan ready: 14 files, 28 changes</span><Button size="sm">Apply plan</Button></Surface>
  </Stack>,
};
