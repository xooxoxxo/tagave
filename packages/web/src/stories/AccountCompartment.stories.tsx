import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AccountCompartment } from '../components/AccountCompartment';

const noop = () => undefined;

/** The sidebar's foot: its width and fill, the row on the bottom edge, edge to edge. */
function SidebarFoot({ children }: { children: ReactNode }) {
  return (
    <div style={{ width: 248, height: 480, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', background: 'var(--bg-nav)' }}>
      {children}
    </div>
  );
}

const meta = {
  title: 'Components/Account compartment',
  component: AccountCompartment,
  parameters: { layout: 'centered', docs: { description: { component: 'The signed-in person at the foot of the sidebar: a band as wide as the sidebar and as tall as the player bar, painted like the bar. Pressing it opens a compartment directly above it (Account, Listening, Appearance, Sign out; on a tablet also who is signed in); it is a disclosure, not a floating menu.' } } },
  decorators: [(Story) => <SidebarFoot><Story /></SidebarFoot>],
  args: { name: 'Oytun', email: 'o@home.example', onAccount: noop, onListening: noop, onSignOut: noop },
} satisfies Meta<typeof AccountCompartment>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const LongAddress: Story = {
  args: { name: 'Deniz Kaya-Okafor Lindqvist', email: 'deniz.kaya-okafor@a-long-household-domain.example' },
};

/** Opened with a press: focus is inside the compartment, no ring anywhere. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole('button', { name: 'Account: Oytun' });
    await userEvent.click(row);
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(await canvas.findByRole('button', { name: 'Sign out' })).toBeVisible();
    await waitFor(() => expect(canvas.getByRole('group', { name: 'Account' })).toHaveFocus());
    // let the height animation finish before the screenshot
    await new Promise((r) => setTimeout(r, 260));
  },
};

/** Keyboard: Enter opens, Tab reaches Account, Escape closes and the row has focus again. */
export const Keyboard: Story = {
  tags: ['no-shot'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole('button', { name: 'Account: Oytun' });
    row.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByRole('group', { name: 'Account' })).toHaveFocus());
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Account' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(row).toHaveFocus();
  },
};
