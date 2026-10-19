import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettingsModulesView, TurnOffChoices, type TurnOffChoice } from '../pages/SettingsModulesPage';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { BASE_VIEW, DUMMY, PLAYER, playerRun } from './modulesFixtures';

const meta = {
  title: 'Settings/Modules',
  component: SettingsModulesView,
  // No screenshot baseline yet: render one on the CI runner (DESIGN.md) and drop `no-shot`.
  tags: ['no-shot'],
  args: { view: BASE_VIEW, onTurnOn: () => undefined, onTurnOff: () => undefined, onDismiss: () => undefined },
  parameters: {
    docs: {
      description: {
        component: 'Settings › Modules: optional parts from the signed catalogue of the running release. With the updater, Turn on / Turn off (after a step-up) and the run step by step; without it, the install-tagave.sh command for each module.',
      },
    },
  },
} satisfies Meta<typeof SettingsModulesView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = {};
const turning = { view: { ...BASE_VIEW, run: playerRun('running'), modules: [{ ...PLAYER, state: 'installing' as const }, DUMMY] } };
export const TurningOn: Story = { args: turning };
export const On: Story = {
  args: { view: { ...BASE_VIEW, run: playerRun('succeeded'), modules: [{ ...PLAYER, state: 'on' }, DUMMY] } },
};
const FAILED = 'Player did not report healthy within 120 s: player reports unhealthy';
export const Failed: Story = {
  args: { view: { ...BASE_VIEW, run: playerRun('rolled_back', FAILED), modules: [{ ...PLAYER, state: 'failed', lastError: FAILED }, DUMMY] } },
};
export const WithoutUpdater: Story = {
  args: { view: { ...BASE_VIEW, mode: 'command', modules: [PLAYER, { ...DUMMY, state: 'off' }] } },
};
export const NotSigned: Story = {
  args: { view: { ...BASE_VIEW, verified: false, problem: 'the release manifest does not match its signature: it was changed after tagave signed it (key 3f0c9a1e5b7d2c44)', modules: [] } },
};
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: turning };

/** The Turn off dialog of the player: the boxes as given (they still tick in the story). */
function TurnOffDialog({ initial }: { initial?: TurnOffChoice }) {
  const m = { ...PLAYER, state: 'on' as const };
  return (
    <ConfirmDialog
      title={`Turn off ${m.name}?`}
      message={<TurnOffChoices m={m} onChange={() => undefined} {...(initial ? { initial } : {})} />}
      confirmLabel="Turn off"
      tone="danger"
      onResult={() => undefined}
    />
  );
}
export const TurnOffDialogKeep: Story = { render: () => <TurnOffDialog /> };
export const TurnOffDialogData: Story = { render: () => <TurnOffDialog initial={{ deleteData: true, deleteHistory: false }} /> };
export const TurnOffDialogHistory: Story = { render: () => <TurnOffDialog initial={{ deleteData: true, deleteHistory: true }} /> };
