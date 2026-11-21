import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { ListenPlatform } from '@tagave/shared';
import { ListenElsewhereView } from '../pages/SettingsListenElsewherePage';

function Picker({ initial, withPrimary = false, saved = false, error = null }: { initial: ListenPlatform[]; withPrimary?: boolean; saved?: boolean; error?: string | null }) {
  const [platforms, setPlatforms] = useState(initial);
  const [primary, setPrimary] = useState<ListenPlatform | null>(withPrimary ? initial[0] ?? null : null);
  return (
    <ListenElsewhereView
      platforms={platforms}
      primary={primary}
      saved={saved}
      error={error}
      onChange={(next) => { setPlatforms(next); if (primary && !next.includes(primary)) setPrimary(null); }}
      {...(withPrimary ? { onPrimary: setPrimary } : {})}
    />
  );
}

const meta = {
  title: 'Settings/Listen elsewhere',
  parameters: {
    docs: {
      description: {
        component: 'Your settings › Listen elsewhere: the streaming platforms the Listen control offers this person (Platforms), and which one Play on opens for a missing album (Missing albums). None until they tick one. A tick and the choice each save when changed. Shown only while the module is on.',
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
export const DesktopWithPrimary: Story = { name: 'Desktop, with a primary, saved', tags: ['viewport-1440'], render: () => <Picker initial={['qobuz', 'apple', 'tidal']} withPrimary saved /> };
export const DesktopNotSaved: Story = { name: 'Desktop, not saved', tags: ['viewport-1440'], render: () => <Picker initial={['qobuz']} withPrimary error="" /> };
export const PhoneWithPrimary: Story = { name: 'Phone, with a primary', tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <Picker initial={['qobuz', 'apple', 'tidal']} withPrimary /> };
