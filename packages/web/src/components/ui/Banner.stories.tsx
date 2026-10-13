import type { Meta, StoryObj } from '@storybook/react-vite';
import { Banner } from './Banner';
import { Stack } from '../../stories/fixtures';

const meta = {
  title: 'Components/Banner',
  component: Banner,
  parameters: { docs: { description: { component: 'A message about the whole page or section: a save result, a blocking problem, a running job. For a passing confirmation use a Toast; for one field use its error text.' } } },
  args: { tone: 'info', children: 'Identification is running. Results appear as albums are processed.' },
  argTypes: { tone: { control: 'inline-radio', options: ['info', 'success', 'warning', 'danger'] } },
} satisfies Meta<typeof Banner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Tones: Story = {
  render: () => <Stack width={640}>
    <Banner tone="success">Changes saved.</Banner>
    <Banner tone="warning">Some files need review before changes can be applied.</Banner>
    <Banner tone="danger">Couldn’t load this library. Try again.</Banner>
    <Banner tone="info">Identification is running. Results appear as albums are processed.</Banner>
  </Stack>,
};

export const LongText: Story = {
  args: { tone: 'warning', children: 'Twelve tracks share one folder but carry four different album-artist tags, two disc numbering schemes and a mix of embedded and sidecar artwork. Review the plan before applying it; every write is journalled and can be reverted.' },
  render: (args) => <div style={{ maxWidth: 520 }}><Banner {...args} /></div>,
};
