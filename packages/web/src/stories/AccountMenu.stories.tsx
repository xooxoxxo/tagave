import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { AccountMenu } from '../components/AccountMenu';

const noop = () => undefined;

/** The sidebar's foot: its width and fill, the row on the bottom edge in a 72px band (the player bar's height). */
function SidebarFoot({ children }: { children: ReactNode }) {
  return (
    <div style={{ width: 248, height: 320, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '0 1.25rem', background: 'var(--bg-nav)' }}>
      <div style={{ height: 72, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>{children}</div>
    </div>
  );
}

const meta = {
  title: 'Components/Account menu',
  component: AccountMenu,
  tags: ['shot-viewport'],
  parameters: { layout: 'centered', docs: { description: { component: 'The signed-in person at the foot of the sidebar: an initial tile, the name and the address as one button. It opens a menu with Account, Listening and Sign out. No rule above it; with the player bar showing the row is exactly as tall as the bar and shares its top edge.' } } },
  decorators: [(Story) => <SidebarFoot><Story /></SidebarFoot>],
  args: { name: 'Oytun', email: 'o@home.example', onAccount: noop, onListening: noop, onSignOut: noop },
} satisfies Meta<typeof AccountMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const LongAddress: Story = {
  args: { name: 'Deniz Kaya-Okafor Lindqvist', email: 'deniz.kaya-okafor@a-long-household-domain.example' },
};

export const Open: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: 'Account: Oytun' }));
    await expect(await within(document.body).findByRole('menuitem', { name: /Sign out/ })).toBeVisible();
  },
};
