import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Fader } from './Fader';

const meta = {
  title: 'Components/Fader',
  component: Fader,
  parameters: { docs: { description: { component: 'A horizontal slider whose fill and thumb move by transform (the DJ view\'s Pitch and crossfader). A slider to assistive technology. Press or drag; arrows step, Page Up / Down step ten times as far, Home / End go to the ends; a double click or Delete puts it back where it rests. `centred` fills from the middle.' } } },
  args: { label: 'Crossfader', value: 0.3, min: 0, max: 1, step: 0.005, start: 'A', end: 'B', onChange: () => undefined },
  render: function Render(args) {
    const [value, setValue] = useState(args.value);
    return <div style={{ width: 360, maxWidth: '100%' }}><Fader {...args} value={value} onChange={setValue} /></div>;
  },
} satisfies Meta<typeof Fader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Crossfader: Story = {};
export const Pitch: Story = { args: { label: 'Deck A pitch', value: 2.4, min: -8, max: 8, step: 0.1, centred: true, defaultValue: 0, start: undefined, end: undefined } };
export const FocusVisible: Story = { parameters: { pseudo: { focusVisible: ['[role="slider"]'] } } };
export const Disabled: Story = { args: { disabled: true } };
