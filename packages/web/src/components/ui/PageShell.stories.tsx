import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { PageShell } from './PageShell';
import { Button } from './Button';
import { EmptyState } from './EmptyState';

const meta = {
  title: 'Components/PageShell',
  component: PageShell,
  parameters: { layout: 'fullscreen', docs: { description: { component: 'Every page in the app frame renders inside PageShell, so moving between pages never shifts the heading: one content column, the heading row (title, aside, actions), optional Tabs, then the content. Detail pages pass `back`; a page with a custom header passes `hero`; a virtualised list passes `fill`.' } } },
  args: { title: 'Albums', aside: '1,284', children: <p>Page content.</p> },
} satisfies Meta<typeof PageShell>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Basic: Story = {};
export const WithSubtitleAndActions: Story = { args: { title: 'Tag changes', subtitle: 'Every write is journalled and can be reverted.', actions: <><Button variant="secondary">Export</Button><Button>New plan</Button></> } };

function Tabbed() {
  const [tab, setTab] = useState('owned');
  return <PageShell title="Collection" tabs={[{ value: 'owned', label: 'Owned', count: 128 }, { value: 'wanted', label: 'Wanted', count: 7 }, { value: 'sold', label: 'Sold' }]} activeTab={tab} onTabChange={setTab}>
    <EmptyState title={`Nothing ${tab}`} text="Albums you mark appear here." />
  </PageShell>;
}
export const WithTabs: Story = { render: () => <Tabbed /> };
export const LongTitle: Story = { args: { title: 'Various Artists — Café del Mar, Volumen Siete (Remastered Deluxe Edition)', aside: '24 tracks' } };
