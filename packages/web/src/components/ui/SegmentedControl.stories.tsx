import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useRef, useState } from 'react';
import { SegmentedControl, ThemeSwitch } from './SegmentedControl';
import { Stack, sizeFrom } from '../../stories/fixtures';
import sheet from './SegmentedControl.stories.module.css';

const meta = {
  title: 'Components/SegmentedControl',
  component: SegmentedControl,
  parameters: { docs: { description: { component: 'One choice out of two to four short options that applies at once (a view mode, a setting). Native radio buttons in a pill track, so arrows, forms and screen readers work. The selected bubble (SlidingPill, shared with Tabs) slides between options with transforms only and is measured to the fraction of a pixel. `size="sm"` for toolbars next to a search field. For switching what a page shows, use Tabs; for more options or long labels, a Select.' } } },
  args: { label: 'What to add', value: 'listen', options: [{ value: 'listen', label: 'A listen' }, { value: 'clipping', label: 'A clipping' }], onChange: () => undefined },
  render: function Render(args, { globals }) {
    const [value, setValue] = useState(args.value);
    return <SegmentedControl {...args} size={args.size ?? sizeFrom(globals)} value={value} onChange={setValue} />;
  },
} satisfies Meta<typeof SegmentedControl<string>>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
export const Small: Story = { args: { label: 'View mode', size: 'sm', value: 'grid', options: [{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }] } };
export const ThreeOptions: Story = { args: { label: 'Colour theme', value: 'light', options: [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] } };
export const LastSelected: Story = { args: { label: 'Plans that can still be reverted', value: 'delete', options: [{ value: 'keep', label: 'Keep them' }, { value: 'delete', label: 'Delete them too' }] } };
export const LongLabels: Story = { args: { label: 'Search box', value: 'beside', options: [{ value: 'below', label: 'Below the logo' }, { value: 'beside', label: 'Next to the logo' }] } };
export const Hover: Story = { parameters: { pseudo: { hover: ['label:not([data-active="true"])'] } }, args: { value: 'listen' } };
export const FocusVisible: Story = { parameters: { pseudo: { focusVisible: ['label:first-of-type input'] } } };
export const RightToLeft: Story = { globals: { dir: 'rtl' }, args: { label: 'ما تضيفه', value: 'listen', options: [{ value: 'listen', label: 'استماع' }, { value: 'clipping', label: 'قصاصة' }] } };
export const Theme: Story = { parameters: { docs: { description: { story: 'ThemeSwitch: the colour theme preference (System, Light, Dark), kept in this browser.' } } }, tags: ['no-shot'], render: () => <ThemeSwitch /> };

/** Every size and selection in one place, for the geometry checks. */
export const Gallery: Story = {
  render: () => <Stack>
    <SegmentedControl label="Maintenance" value="off" onChange={() => undefined} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} />
    <SegmentedControl label="Wordmark" value="hidden" onChange={() => undefined} options={[{ value: 'shown', label: 'Shown' }, { value: 'hidden', label: 'Hidden' }]} />
    <SegmentedControl label="Review editor" size="sm" value="preview" onChange={() => undefined} options={[{ value: 'write', label: 'Write' }, { value: 'preview', label: 'Preview' }]} />
    <SegmentedControl label="Auto-accept" size="sm" value="on" onChange={() => undefined} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
  </Stack>,
};

function InSheetDemo() {
  const ref = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState('listen');
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={sheet.sheet} aria-label="Add to this album">
    <h2 className={sheet.title}>Add to this album</h2>
    <SegmentedControl label="What to add" value={kind} onChange={setKind} options={[{ value: 'listen', label: 'A listen' }, { value: 'clipping', label: 'A clipping' }]} />
  </dialog>;
}

/** The control in a modal sheet that slides and scales in as it opens (the album's Add sheet). */
export const InSheet: Story = { tags: ['shot-viewport'], parameters: { layout: 'fullscreen', docs: { story: { inline: false, iframeHeight: 320 } } }, render: () => <InSheetDemo /> };
