import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SlidingPill } from './SlidingPill';
import { SegmentedControl } from './SegmentedControl';
import { Tabs } from './Tabs';
import { Stack } from '../../stories/fixtures';

const meta = {
  title: 'Components/SlidingPill',
  component: SlidingPill,
  parameters: { docs: { description: { component: 'The moving bubble of Tabs and SegmentedControl; not used on its own. useSlidingIndicator measures the selected item (to the fraction of a pixel, cancelling any ancestor transform) and places three parts with transforms only: two round caps that translate and a middle band that stretches. A change of selection slides like a small spring; the first placement, a resize and a font load are instant; reduced motion is always instant. Until it is placed, the selected item paints the same bubble itself.' } } },
} satisfies Meta<typeof SlidingPill>;
export default meta;
type Story = StoryObj;

function Both() {
  const [a, setA] = useState('grid');
  const [b, setB] = useState('credits');
  return <Stack>
    <SegmentedControl label="View mode" value={a} onChange={setA} options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }, { value: 'shelf', label: 'Shelf' }]} />
    <Tabs label="Album sections" value={b} onChange={setB} items={[{ value: 'tracks', label: 'Tracks' }, { value: 'credits', label: 'Credits' }, { value: 'reviews', label: 'Reviews' }]} />
  </Stack>;
}

export const InTabsAndSegmentedControl: Story = { render: () => <Both /> };
