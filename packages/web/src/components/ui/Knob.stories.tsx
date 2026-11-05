import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Knob } from './Knob';
import { Fader } from './Fader';
import { Stack } from '../../stories/fixtures';

const meta = {
  title: 'Components/Knob',
  component: Knob,
  parameters: { docs: { description: { component: 'A knob for a continuous value (the DJ view\'s effects): a still ring and a notch that turns by transform, its name and value under it. A slider to assistive technology. Drag up or right to turn it up; arrows step, Page Up / Down step ten times as far, Home / End go to the ends; a double click or Delete puts it back where it rests (the notch takes the accent away from rest).' } } },
  args: { label: 'Deck A low', caption: 'Low', value: 0, min: -12, max: 12, step: 0.5, defaultValue: 0, format: (v: number) => `${v > 0 ? '+' : ''}${v} dB`, onChange: () => undefined },
  render: function Render(args) {
    const [value, setValue] = useState(args.value);
    return <Knob {...args} value={value} onChange={setValue} />;
  },
} satisfies Meta<typeof Knob>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AtRest: Story = {};
export const Turned: Story = { args: { value: -7.5 } };
export const FocusVisible: Story = { parameters: { pseudo: { focusVisible: ['[role="slider"]'] } } };
export const Disabled: Story = { args: { disabled: true, value: 6 } };

/** Knobs and faders side by side, at rest and away from it. */
export const Gallery: Story = {
  render: () => (
    <Stack>
      <div style={{ display: 'flex', gap: 8 }}>
        <Knob label="Filter" value={0} min={-1} max={1} defaultValue={0} format={() => 'Off'} onChange={() => undefined} />
        <Knob label="Low" value={-12} min={-12} max={12} defaultValue={0} format={() => '−12 dB'} onChange={() => undefined} />
        <Knob label="Mid" value={4} min={-12} max={12} defaultValue={0} format={() => '+4 dB'} onChange={() => undefined} />
        <Knob label="Mix" value={1} min={0} max={1} format={() => '100 %'} onChange={() => undefined} />
      </div>
      <div style={{ width: 320 }}><Fader label="Pitch" value={2.4} min={-8} max={8} step={0.1} centred onChange={() => undefined} /></div>
      <div style={{ width: 320 }}><Fader label="Pitch" value={-5} min={-8} max={8} step={0.1} centred onChange={() => undefined} /></div>
      <div style={{ width: 320 }}><Fader label="Crossfader" value={0.3} min={0} max={1} onChange={() => undefined} start="A" end="B" /></div>
    </Stack>
  ),
};
