import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Chip } from './Chip';
import { Row, Stack } from '../../stories/fixtures';

const meta = {
  title: 'Components/Chip',
  component: Chip,
  parameters: { docs: { description: { component: 'A small pill for filters and facts. With onClick it is a toggle button (aria-pressed follows `active`); without, a plain label. A status dot carries colour; the words carry the meaning.' } } },
  args: { children: 'Lossless' },
  argTypes: { dot: { control: 'select', options: [undefined, true, 'ok', 'warn', 'danger', 'accent'] } },
} satisfies Meta<typeof Chip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Facts: Story = {
  render: () => <Row><Chip dot="ok">Matched</Chip><Chip dot="warn">4 artist tags</Chip><Chip dot="danger">Unreadable</Chip><Chip dot="accent">New</Chip><Chip>FLAC</Chip></Row>,
};

function Filters() {
  const [on, setOn] = useState<string[]>(['Needs review']);
  const toggle = (v: string) => setOn((c) => (c.includes(v) ? c.filter((x) => x !== v) : [...c, v]));
  return <Row>{['Needs review', 'Compilations', 'Missing cover', 'Lossless'].map((v) => <Chip key={v} active={on.includes(v)} dot={v === 'Needs review' ? true : undefined} onClick={() => toggle(v)}>{v}</Chip>)}</Row>;
}

export const FilterToggles: Story = { render: () => <Filters /> };

export const Hover: Story = {
  parameters: { pseudo: { hover: ['button'] } },
  render: () => <Row><Chip onClick={() => undefined}>Compilations</Chip><Chip active onClick={() => undefined}>Needs review</Chip></Row>,
};

export const FocusVisible: Story = {
  parameters: { pseudo: { focusVisible: ['button'] } },
  render: () => <Row><Chip onClick={() => undefined}>Compilations</Chip><Chip active onClick={() => undefined}>Needs review</Chip></Row>,
};

export const Disabled: Story = {
  render: () => <Row><Chip onClick={() => undefined} disabled>Compilations</Chip><Chip active onClick={() => undefined} disabled>Needs review</Chip></Row>,
};

export const LongTextAndRtl: Story = {
  globals: { dir: 'rtl' },
  render: () => <Stack><Row><Chip dot="warn">أربعة وسوم مختلفة لفنان الألبوم</Chip><Chip active onClick={() => undefined}>بلا غلاف</Chip></Row></Stack>,
};
