import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Tabs, type TabItem } from './Tabs';

const meta = {
  title: 'Components/Tabs',
  component: Tabs,
  parameters: { docs: { description: { component: 'Switches what a page or card shows (sections of the album, views of the collection). Pass `panelId` when you render the tab panel, and give the panel aria-labelledby={tabIdFor(panelId, value)}. Arrow keys, Home and End move. The selected bubble is the same SlidingPill as SegmentedControl. A strip wider than its column scrolls sideways with faded edges. To change a setting, use SegmentedControl.' } } },
  args: {
    label: 'Album sections',
    value: 'credits',
    items: [{ value: 'tracks', label: 'Tracks' }, { value: 'credits', label: 'Credits' }, { value: 'reviews', label: 'Reviews' }, { value: 'files', label: 'Files' }, { value: 'activity', label: 'Activity' }],
  },
  render: function Render(args) {
    const [value, setValue] = useState(args.value);
    return <Tabs {...args} value={value} onChange={setValue} />;
  },
} satisfies Meta<typeof Tabs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
export const FirstSelected: Story = { args: { value: 'tracks' } };
export const WithCounts: Story = { args: { label: 'Collection views', value: 'owned', items: [{ value: 'owned', label: 'Owned', count: 128 }, { value: 'wanted', label: 'Wanted', count: 7 }, { value: 'sold', label: 'Sold' }] } };
export const Hover: Story = { parameters: { pseudo: { hover: ['button[aria-selected="false"]'] } } };
export const FocusVisible: Story = { parameters: { pseudo: { focusVisible: ['button[aria-selected="true"]'] } } };

const many: TabItem[] = ['Overview', 'Tracks', 'Credits', 'Reviews', 'Editions', 'Files', 'Artwork', 'Activity', 'History'].map((l) => ({ value: l.toLowerCase(), label: l }));
export const Overflowing: Story = { args: { items: many, value: 'overview' }, render: function Render(args) { const [v, setV] = useState(args.value); return <div style={{ width: 340 }}><Tabs {...args} value={v} onChange={setV} /></div>; } };
export const RightToLeft: Story = { globals: { dir: 'rtl' }, args: { value: 'b', items: [{ value: 'a', label: 'المقاطع' }, { value: 'b', label: 'المساهمون' }, { value: 'c', label: 'المراجعات' }] } };
