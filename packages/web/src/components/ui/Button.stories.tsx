import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, IconButton } from './Button';
import { UndoIcon } from './icons';
import { EditIcon, PlayIcon, RevertIcon, Row, Stack, sizeFrom } from '../../stories/fixtures';

const meta = {
  title: 'Components/Button',
  component: Button,
  parameters: {
    docs: {
      description: {
        component: 'Every action in the app is a Button, IconButton or LinkButton. One primary drop per view; secondary for the rest, quiet for low-emphasis actions next to content. `quiet-danger` is the resting look of a destructive trigger; the full `danger` drop is only the last button of a confirm dialog. Buttons default to type="button". `loading` keeps the width and colour and blocks repeat presses.',
      },
    },
  },
  args: { children: 'Apply plan', variant: 'primary', disabled: false, loading: false },
  argTypes: { variant: { control: 'inline-radio', options: ['primary', 'secondary', 'quiet', 'quiet-danger', 'danger'] }, size: { control: 'inline-radio', options: ['md', 'sm'] } },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Follows the Size toolbar unless `size` is set. */
export const Playground: Story = {
  render: (args, { globals }) => <Button {...args} size={args.size ?? sizeFrom(globals)} />,
};

const variants = ['primary', 'secondary', 'quiet', 'quiet-danger', 'danger'] as const;

export const Variants: Story = {
  render: () => <Stack>
    <Row>{variants.map((v) => <Button key={v} variant={v}>{v === 'danger' ? 'Delete (dialog only)' : v === 'quiet-danger' ? 'Delete' : v === 'quiet' ? 'Cancel' : v === 'secondary' ? 'Preview' : 'Apply plan'}</Button>)}</Row>
    <Row>{variants.map((v) => <Button key={v} variant={v} size="sm">{v}</Button>)}</Row>
  </Stack>,
};

export const WithIcon: Story = { args: { variant: 'secondary', children: <><UndoIcon />Revert</> } };

export const Disabled: Story = {
  render: () => <Row>{variants.map((v) => <Button key={v} variant={v} disabled>{v}</Button>)}</Row>,
};

export const Loading: Story = {
  render: () => <Row><Button loading>Saving…</Button><Button variant="secondary" loading>Preview</Button><Button size="sm" loading>Fix folder tags</Button></Row>,
};

export const Hover: Story = {
  parameters: { pseudo: { hover: ['button'] } },
  render: () => <Row>{variants.map((v) => <Button key={v} variant={v}>{v}</Button>)}</Row>,
};

export const FocusVisible: Story = {
  parameters: { pseudo: { focusVisible: ['button'] } },
  render: () => <Row>{variants.map((v) => <Button key={v} variant={v}>{v}</Button>)}</Row>,
};

export const Pressed: Story = {
  parameters: { pseudo: { active: ['button'] } },
  render: () => <Row>{variants.map((v) => <Button key={v} variant={v}>{v}</Button>)}</Row>,
};

export const LongLabel: Story = {
  render: () => <div style={{ width: 260 }}><Button variant="secondary">Write the album artist to every file in this folder</Button></div>,
};

export const RightToLeft: Story = {
  globals: { dir: 'rtl' },
  render: () => <Row><Button>تطبيق الخطة</Button><Button variant="secondary"><UndoIcon />إرجاع</Button></Row>,
};

export const IconButtons: Story = {
  parameters: { docs: { description: { story: 'IconButton: a circular drop with only an icon. `label` is the accessible name and the native tooltip. Defaults to the clear secondary bubble.' } } },
  render: () => <Stack>
    <Row>
      <IconButton label="Play" variant="primary"><PlayIcon /></IconButton>
      <IconButton label="Edit tags"><EditIcon /></IconButton>
      <IconButton label="Revert file" variant="quiet"><RevertIcon /></IconButton>
      <IconButton label="Delete" variant="quiet-danger"><EditIcon /></IconButton>
    </Row>
    <Row>
      <IconButton label="Play" variant="primary" size="sm"><PlayIcon /></IconButton>
      <IconButton label="Edit tags" size="sm"><EditIcon /></IconButton>
      <IconButton label="Play" variant="primary" disabled><PlayIcon /></IconButton>
      <IconButton label="Edit tags" loading><EditIcon /></IconButton>
    </Row>
  </Stack>,
};
