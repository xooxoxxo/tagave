import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { CatalogueModuleView, ModuleSwitchView, ModulesListView, SettingOffChoices, TurnOffChoices, mcDeleted, turnOffKey, type CatalogueModuleViewProps, type OffChoice, type TurnOffChoice } from '../pages/SettingsModulesPage';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { BASE_VIEW, DUMMY, PLAYER, playerRun } from './modulesFixtures';

const meta = {
  title: 'Settings/Modules',
  component: ModulesListView,
  // No screenshot baseline yet: render one on the CI runner (DESIGN.md) and drop `no-shot`.
  tags: ['no-shot'],
  args: {
    rows: [
      { slug: 'player', name: 'Player', state: 'On', on: true },
      { slug: 'lidarr', name: 'Lidarr', state: 'On', on: true },
      { slug: 'listen-elsewhere', name: 'Listen elsewhere', state: 'On', on: true },
      { slug: 'music-connections', name: 'Music Connections', state: 'Off', on: false },
      { slug: 'playlists', name: 'Playlists', state: 'On', on: true },
    ],
  },
  parameters: {
    docs: {
      description: {
        component: 'Settings › Modules: one row per module with its state; each opens Settings › Modules › <module>, which starts with the module’s Off | On and holds everything it needs.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 850, padding: 24 }}><Story /></div>],
} satisfies Meta<typeof ModulesListView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = {};
/** A listener: only the modules with something of theirs. */
export const Member: Story = { args: { rows: [{ slug: 'player', name: 'Player', state: 'On', on: true }, { slug: 'listen-elsewhere', name: 'Listen elsewhere', state: 'On', on: true }] } };
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };

const noop = () => undefined;
const page = (p: Partial<CatalogueModuleViewProps>) => <><h2>Player</h2><CatalogueModuleView view={BASE_VIEW} id="player" name="Player" onSwitch={noop} onDismiss={noop} {...p} /></>;

/** Settings › Modules › Player, its Off | On from the updater. */
export const PlayerOff: Story = { render: () => page({}) };
export const PlayerTurningOn: Story = { render: () => page({ view: { ...BASE_VIEW, run: playerRun('running'), modules: [{ ...PLAYER, state: 'installing' }, DUMMY] } }) };
export const PlayerOn: Story = { render: () => page({ view: { ...BASE_VIEW, run: playerRun('succeeded'), modules: [{ ...PLAYER, state: 'on' }, DUMMY] } }) };
const FAILED = 'Player did not report healthy within 120 s: player reports unhealthy';
export const PlayerFailed: Story = { render: () => page({ view: { ...BASE_VIEW, run: playerRun('rolled_back', FAILED), modules: [{ ...PLAYER, state: 'failed', lastError: FAILED }, DUMMY] } }) };
export const PlayerWithoutUpdater: Story = { render: () => page({ view: { ...BASE_VIEW, mode: 'command', modules: [PLAYER, DUMMY] } }) };
/** Run from source: no updater, no release keys, so nothing to run. */
export const PlayerNotAvailableHere: Story = { render: () => page({ view: { ...BASE_VIEW, mode: 'command', verified: false, problem: null, modules: [{ ...PLAYER, available: false, reason: 'Not available on this install.' }] } }) };
export const NotSigned: Story = { render: () => page({ view: { ...BASE_VIEW, verified: false, problem: 'the release manifest does not match its signature: it was changed after tagave signed it (key 3f0c9a1e5b7d2c44)', modules: [] } }) };
export const PlayerPhone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => page({ view: { ...BASE_VIEW, run: playerRun('running'), modules: [{ ...PLAYER, state: 'installing' }, DUMMY] } }) };

/** A module that is a setting (Lidarr): the same Off | On, with its label and what it holds. */
export const SettingSwitch: Story = { render: () => <><h2>Lidarr</h2><ModuleSwitchView name="Lidarr" label="Get missing albums" on meta="2 getting" onSwitch={noop} /></> };

/** The Turn off dialog of the player: the choices as given (they still switch in the story, and the key follows). */
function TurnOffDialog({ initial }: { initial?: TurnOffChoice }) {
  const m = { ...PLAYER, state: 'on' as const };
  const [data, setData] = useState(initial?.deleteData ?? false);
  return (
    <ConfirmDialog
      title={`Turn off ${m.name}?`}
      message={<TurnOffChoices m={m} onChange={(c) => setData(c.deleteData)} {...(initial ? { initial } : {})} />}
      {...turnOffKey(data)}
      onResult={() => undefined}
    />
  );
}
export const TurnOffDialogKeep: Story = { render: () => <TurnOffDialog /> };
export const TurnOffDialogData: Story = { render: () => <TurnOffDialog initial={{ deleteData: true, deleteHistory: false }} /> };
export const TurnOffDialogHistory: Story = { render: () => <TurnOffDialog initial={{ deleteData: true, deleteHistory: true }} /> };

/** The Turn off dialog of a module that is a setting (Music Connections): Kept, then Delete its data. */
function SettingOffDialog({ initial }: { initial?: OffChoice }) {
  const [data, setData] = useState(initial?.deleteData ?? false);
  return (
    <ConfirmDialog
      title="Turn off Music Connections?"
      message={<SettingOffChoices kept="connections, items, filled IDs" deleted={mcDeleted} keepFills onChange={(c) => setData(c.deleteData)} {...(initial ? { initial } : {})} />}
      {...turnOffKey(data)}
      onResult={() => undefined}
    />
  );
}
export const SettingOffDialogKeep: Story = { render: () => <SettingOffDialog /> };
export const SettingOffDialogDelete: Story = { render: () => <SettingOffDialog initial={{ deleteData: true, keepFills: false }} /> };
