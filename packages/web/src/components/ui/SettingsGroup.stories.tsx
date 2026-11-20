import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { SegmentedControl } from './SegmentedControl';
import { Input, Select } from './FormControl';
import { SaveStatus } from './SaveStatus';
import { SettingsSave } from './SettingsSave';
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
/** tags inline on each story: the indexer reads them statically */
const phone = { globals: { viewport: { value: 'phone' } }, render: (args) => <SettingsGroup {...args}><Rows /></SettingsGroup> } satisfies Story;

export const Default: Story = {};
export const WithHelp: Story = withHelp;
export const WithStatus: Story = withStatus;
export const PhoneDefault: Story = { ...phone, tags: ['phone'] };
export const PhoneWithHelp: Story = { ...phone, ...withHelp, tags: ['phone'] };
export const PhoneWithStatus: Story = { ...phone, ...withStatus, tags: ['phone'] };

/* the save model: an instant choice shows its status in the head; a typed group has one Save under its rows */
function InstantRows() {
  return <SettingsRow label="Schedule">
    <Select dense defaultValue="nightly" style={{ width: '9.5rem' }}>
      <option value="off">Off</option>
      <option value="nightly">Nightly</option>
      <option value="weekly">Weekly</option>
    </Select>
  </SettingsRow>;
}
function TypedRows() {
  return <>
    <SettingsRow label="Server address">
      <Input dense defaultValue="https://music.example.com" style={{ width: '14rem' }} />
    </SettingsRow>
    <SettingsRow label="User name">
      <Input dense defaultValue="robin" style={{ width: '14rem' }} />
    </SettingsRow>
  </>;
}
const noop = () => {};
const onPhone = { globals: { viewport: { value: 'phone' } } };
const instant = { args: { title: 'Scheduled backups', meta: null, status: <SaveStatus state="saved" /> } } satisfies Story;
const changed = { args: { title: 'Connection', meta: null, after: <SettingsSave dirty onSave={noop} /> } } satisfies Story;
const failed = { args: { title: 'Connection', meta: null, after: <SettingsSave dirty onSave={noop} state="failed" detail="the server did not answer" /> } } satisfies Story;
const instantAt = (width?: number): NonNullable<Story['render']> => (args) => <Stack {...(width ? { width } : {})}><SettingsGroup {...args}><InstantRows /></SettingsGroup></Stack>;
const typedAt = (width?: number): NonNullable<Story['render']> => (args) => <Stack {...(width ? { width } : {})}><SettingsGroup {...args}><TypedRows /></SettingsGroup></Stack>;

export const InstantChoiceSaved: Story = { ...instant, name: 'Instant choice saved', render: instantAt(560), tags: ['no-shot'] };
export const TypedGroupChanged: Story = { ...changed, name: 'Typed group, changed', render: typedAt(560), tags: ['no-shot'] };
export const TypedGroupFailed: Story = { ...failed, name: 'Typed group, failed', render: typedAt(560), tags: ['no-shot'] };
export const PhoneInstantChoiceSaved: Story = { ...instant, ...onPhone, name: 'Phone instant choice saved', render: instantAt(), tags: ['phone', 'no-shot'] };
export const PhoneTypedGroupChanged: Story = { ...changed, ...onPhone, name: 'Phone typed group, changed', render: typedAt(), tags: ['phone', 'no-shot'] };
export const PhoneTypedGroupFailed: Story = { ...failed, ...onPhone, name: 'Phone typed group, failed', render: typedAt(), tags: ['phone', 'no-shot'] };
