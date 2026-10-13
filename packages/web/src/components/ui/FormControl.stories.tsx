import type { Meta, StoryObj } from '@storybook/react-vite';
import { Input, PendingValue, SearchField, Select, TextField, Textarea } from './FormControl';
import { Stack, sizeFrom } from '../../stories/fixtures';

const meta = {
  title: 'Components/FormControl',
  component: TextField,
  parameters: { docs: { description: { component: 'Fields. TextField keeps the visible label, hint and error connected to the input (aria-describedby, aria-invalid). `previousValue` shows a pending edit\'s old value struck through. SearchField is the search pill with no visible label (`label` is its accessible name) and a "/" shortcut. Input, Select and Textarea are the bare controls for custom layouts. `dense` is the 36px height for toolbars and table rows.' } } },
  args: { label: 'Library name', hint: 'A name that helps you recognise this library.' },
  render: (args, { globals }) => <div style={{ width: 380 }}><TextField {...args} dense={args.dense ?? sizeFrom(globals) === 'sm'} /></div>,
} satisfies Meta<typeof TextField>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
export const Required: Story = { args: { required: true, defaultValue: 'Home' } };
export const WithError: Story = { args: { required: true, error: 'Enter a library name.', hint: undefined } };
export const Disabled: Story = { args: { disabled: true, value: 'Read-only example', readOnly: true } };
export const Dense: Story = { args: { dense: true } };
export const PendingEdit: Story = { args: { label: 'Album artist', defaultValue: 'Various Artists', previousValue: 'DJ Example', hint: undefined } };
export const PendingFromEmpty: Story = { args: { label: 'Composer', defaultValue: 'Bill Evans', previousValue: null, hint: undefined } };
export const Focused: Story = { parameters: { pseudo: { focusVisible: ['input'], focus: ['input'] } } };
export const LongText: Story = { args: { label: 'Album title as it appears on the release, including edition and remaster notes', defaultValue: 'Café del Mar, Volumen Siete (20th Anniversary Remastered Deluxe Edition)', hint: 'Long values scroll inside the field; the label wraps.' } };
export const RightToLeft: Story = { globals: { dir: 'rtl' }, args: { label: 'اسم المكتبة', defaultValue: 'الموسيقى المنزلية', dir: 'auto', hint: 'اسم يساعدك على التعرف على هذه المكتبة.' } };

export const Search: Story = {
  render: () => <Stack width={420}>
    <SearchField label="Search the library" placeholder="Albums, artists, folders" />
    <SearchField label="Search (dense)" dense placeholder="Filter" />
    <SearchField label="Search without shortcut" slashShortcut={false} defaultValue="Coltrane" />
  </Stack>,
};

export const BareControls: Story = {
  render: () => <Stack width={380}>
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>Default view<Select defaultValue="grid"><option value="grid">Album grid</option><option value="list">Album list</option></Select></label>
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>Disc<Input inputMode="numeric" defaultValue="1" /></label>
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>Notes<Textarea placeholder="Add a note about your library" /></label>
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>Dense select<Select dense defaultValue="a"><option value="a">Newest first</option></Select></label>
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>Disabled<Select disabled defaultValue="a"><option value="a">Album grid</option></Select></label>
  </Stack>,
};

export const PendingValueLine: Story = {
  render: () => <Stack><PendingValue previous="DJ Example" /><PendingValue previous="" /></Stack>,
};
