import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { SegmentedControl } from './SegmentedControl';
import { Input } from './FormControl';
import { Stack } from '../../stories/fixtures';

function Rows() {
  const [on, setOn] = useState<'off' | 'on'>('on');
  return <>
    <SettingsRow label="Library name">
      <Input dense defaultValue="Home" style={{ width: '9.5rem' }} />
    </SettingsRow>
    <SettingsRow label="Scan on start" as="div">
      <SegmentedControl label="Scan on start" size="sm" value={on} onChange={setOn} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} />
    </SettingsRow>
    <SettingsRow label="Tracks" value={<span style={{ color: 'var(--ink-3)', fontVariantNumeric: 'tabular-nums' }}>12,408</span>} />
  </>;
}

const meta = {
  title: 'Components/UI/Settings group',
  component: SettingsGroup,
  parameters: { docs: { description: { component: 'One group of settings: a small uppercase head (title, optional `?` help, a save status, a meta value), then rows on one surface. A row is a label and one compact control or value, rows divided by a hairline. A single choice saves when changed; typed fields save with one Save per group. Help sits behind the `?`, never inline. Use `as="div"` on a row whose control is a group (SegmentedControl).' } } },
  args: { title: 'Library', meta: '3 settings' },
  render: (args) => <Stack width={560}><SettingsGroup {...args}><Rows /></SettingsGroup></Stack>,
} satisfies Meta<typeof SettingsGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

const withHelp = { args: { help: 'Applies to every person in this tagave.' } } satisfies Story;
const withStatus = { args: { status: <span role="status" style={{ color: 'var(--ink-3)', fontSize: 'var(--font-size-xs)' }}>✓ Saved</span> } } satisfies Story;
const phone = { globals: { viewport: { value: 'phone' } }, tags: ['phone'], render: (args) => <SettingsGroup {...args}><Rows /></SettingsGroup> } satisfies Story;

export const Default: Story = {};
export const WithHelp: Story = withHelp;
export const WithStatus: Story = withStatus;
export const PhoneDefault: Story = { ...phone };
export const PhoneWithHelp: Story = { ...phone, ...withHelp };
export const PhoneWithStatus: Story = { ...phone, ...withStatus };
