import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmbossIconButton } from './EmbossIconButton';
import { BackIcon, KebabIcon, ShuffleIcon, WrenchIcon } from './icons';

const meta = {
  title: 'Components/EmbossIconButton',
  component: EmbossIconButton,
  args: { label: 'Shuffle', children: <ShuffleIcon />, place: 'page' },
  parameters: {
    docs: {
      description: {
        component: 'The app\'s icon button: the icon alone, embossed (a fine highlight above the glyph, a soft shade under it), no circle and no key. On the page, hover and focus show a niche: a thin recessed outline around the icon\'s area. In a header (`place="header"`) hover shows no outline. Keyboard focus is a ring everywhere. A switch passes `aria-pressed`, and on it takes the accent. The album page and its header use it first.',
      },
    },
  },
} satisfies Meta<typeof EmbossIconButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Rest: Story = {};
export const Hover: Story = { parameters: { pseudo: { hover: ['button'] } } };
export const Focus: Story = { parameters: { pseudo: { focusVisible: ['button'] } } };
export const Pressed: Story = { parameters: { pseudo: { hover: ['button'], active: ['button'] } } };
export const Disabled: Story = { args: { disabled: true } };
export const On: Story = { args: { label: 'Turn off Maintenance', 'aria-pressed': true, children: <WrenchIcon /> } };

/** A header's icons: no outline on hover, the focus ring stays. */
export const InTheHeader: Story = {
  render: (args) => (
    <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
      <EmbossIconButton {...args} place="header" label="Back to Albums"><BackIcon /></EmbossIconButton>
      <EmbossIconButton {...args} place="header" label="More for this album"><KebabIcon /></EmbossIconButton>
    </div>
  ),
};
export const InTheHeaderHover: Story = { ...InTheHeader, parameters: { pseudo: { hover: ['button'] } } };
export const InTheHeaderFocus: Story = { ...InTheHeader, parameters: { pseudo: { focusVisible: ['button'] } } };
