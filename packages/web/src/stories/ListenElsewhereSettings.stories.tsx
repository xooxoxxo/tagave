import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { ListenPlatform } from '@tagave/shared';
import { ListenElsewhereView } from '../pages/SettingsListenElsewherePage';

function Picker({ initial }: { initial: ListenPlatform[] }) {
  const [platforms, setPlatforms] = useState(initial);
  return <ListenElsewhereView platforms={platforms} onChange={setPlatforms} />;
}

const meta = {
  title: 'Settings/Listen elsewhere',
  parameters: {
    docs: {
      description: {
        component: 'Settings › Modules › Listen elsewhere: the streaming platforms the Listen control offers this person. None until they tick one. Shown only while the module is on.',
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
