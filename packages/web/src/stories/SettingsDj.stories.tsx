import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { DJ_DEFAULTS, type DjSimpleSettings } from '@tagave/shared';
import type { SaveState } from '../components/ui';
import { SettingsDjView } from '../pages/SettingsDjPage';

function Live({ initial, availableHere = true, state = null }: { initial: DjSimpleSettings; availableHere?: boolean; state?: SaveState }) {
  const [s, set] = useState(initial);
  return <SettingsDjView availableHere={availableHere} settings={s} state={state} onChange={(p) => set((v) => ({ ...v, ...p }))} />;
}

const meta = {
  title: 'Settings/Modules/DJ',
  component: SettingsDjView,
  // The older stories have no baseline yet; the settings layout's stories opt in with `!no-shot`.
  tags: ['no-shot'],
  args: { availableHere: true, settings: DJ_DEFAULTS, onChange: () => undefined },
  parameters: {
    docs: {
      description: {
        component: 'Your settings › DJ, each person’s Simple mode, one group: Crossfade Off / Fixed / Auto, Length (2 to 12 s, only for Fixed), Beat-aligned, Gapless albums. Each saves when changed, the outcome in the group’s head. Kept with the person (user_prefs), applied by the device that plays. An iOS home-screen app can’t mix, so the group says Not on this device.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 850, padding: 24 }}><Story /></div>],
} satisfies Meta<typeof SettingsDjView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = { render: () => <Live initial={DJ_DEFAULTS} /> };
export const Fixed: Story = { render: () => <Live initial={{ ...DJ_DEFAULTS, crossfade: 'fixed', lengthSec: 8 }} /> };
export const AutoBeatAligned: Story = { name: 'Auto, beat-aligned', render: () => <Live initial={{ ...DJ_DEFAULTS, crossfade: 'auto', beatAligned: true }} /> };
export const NotOnThisDevice: Story = { name: 'Not on this device (iOS home-screen app)', render: () => <Live initial={DJ_DEFAULTS} availableHere={false} /> };
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <Live initial={{ ...DJ_DEFAULTS, crossfade: 'fixed' }} /> };
export const DesktopSaved: Story = { name: 'Desktop, saved', tags: ['viewport-1440', '!no-shot'], render: () => <Live initial={{ ...DJ_DEFAULTS, crossfade: 'auto', gaplessAlbums: true }} state="saved" /> };
export const DesktopNotSaved: Story = { name: 'Desktop, not saved', tags: ['viewport-1440', '!no-shot'], render: () => <Live initial={DJ_DEFAULTS} state="failed" /> };
export const PhoneSaved: Story = { name: 'Phone, saved', tags: ['phone', '!no-shot'], globals: { viewport: { value: 'phone' } }, render: () => <Live initial={{ ...DJ_DEFAULTS, crossfade: 'auto' }} state="saved" /> };
export const PhoneNotOnThisDevice: Story = { name: 'Phone, not on this device', tags: ['phone', '!no-shot'], globals: { viewport: { value: 'phone' } }, render: () => <Live initial={DJ_DEFAULTS} availableHere={false} /> };
