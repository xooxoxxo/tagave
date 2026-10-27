import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { ListenPlatform } from '@tagave/shared';
import { ListenElsewhereOff, ListenElsewhereView } from '../pages/SettingsListenElsewherePage';
import { ListenLinksModuleRow } from '../pages/SettingsModulesPage';

function Picker({ initial }: { initial: ListenPlatform[] }) {
  const [platforms, setPlatforms] = useState(initial);
  return <ListenElsewhereView platforms={platforms} onChange={setPlatforms} />;
}

const meta = {
  title: 'Settings/Listen elsewhere',
  parameters: {
    docs: {
      description: {
        component: 'Settings › Listen elsewhere: the streaming platforms the Listen control offers this person. None until they tick one. Listed only while the module is on (Settings › Modules); a direct link says it is off.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 850, padding: 24 }}><Story /></div>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const NoneTicked: Story = { render: () => <Picker initial={[]} /> };
export const Picked: Story = { render: () => <Picker initial={['qobuz', 'apple']} /> };
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <Picker initial={['qobuz']} /> };
export const Off: Story = { render: () => <ListenElsewhereOff owner /> };

/** Settings › Modules: the Listen elsewhere row. */
export const ModuleRowOn: Story = {
  render: () => <ListenLinksModuleRow view={{ enabled: true, albums: 214, artists: 38, people: 2 }} onTurnOn={() => undefined} onTurnOff={() => undefined} />,
};
export const ModuleRowOff: Story = {
  render: () => <ListenLinksModuleRow view={{ enabled: false, albums: 0, artists: 0, people: 0 }} onTurnOn={() => undefined} onTurnOff={() => undefined} />,
};
