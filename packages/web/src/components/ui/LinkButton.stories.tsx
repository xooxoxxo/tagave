import type { Meta, StoryObj } from '@storybook/react-vite';
import { LinkButton } from './LinkButton';
import { Row } from '../../stories/fixtures';

const meta = {
  title: 'Components/LinkButton',
  component: LinkButton,
  parameters: { docs: { description: { component: 'Navigation that looks like a button: a router Link with the Button classes. Use it when the action goes somewhere; never put a link inside a Button.' } } },
  args: { to: '/', children: 'Open library', variant: 'primary' },
  argTypes: { variant: { control: 'inline-radio', options: ['primary', 'secondary', 'quiet'] }, size: { control: 'inline-radio', options: ['md', 'sm'] } },
} satisfies Meta<typeof LinkButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Variants: Story = {
  render: () => <Row>
    <LinkButton to="/">Open library</LinkButton>
    <LinkButton to="/" variant="secondary">Settings</LinkButton>
    <LinkButton to="/" variant="quiet">Back to albums</LinkButton>
    <LinkButton to="/" size="sm" variant="secondary">Details</LinkButton>
  </Row>,
};

export const FocusVisible: Story = {
  parameters: { pseudo: { focusVisible: ['a'] } },
  render: () => <Row><LinkButton to="/">Open library</LinkButton><LinkButton to="/" variant="secondary">Settings</LinkButton></Row>,
};
