import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { DJ_DEFAULTS, type DjSimpleSettings } from '@tagave/shared';
import { SettingsDjView } from '../pages/SettingsDjPage';

function Live({ initial, availableHere = true }: { initial: DjSimpleSettings; availableHere?: boolean }) {
  const [s, set] = useState(initial);
  return <SettingsDjView availableHere={availableHere} settings={s} onChange={(p) => set((v) => ({ ...v, ...p }))} />;
}

const meta = {
  title: 'Settings/Modules/DJ',
  component: SettingsDjView,
  // No screenshot baseline yet: render one on the CI runner (DESIGN.md) and drop `no-shot`.
  tags: ['no-shot'],
  args: { availableHere: true, settings: DJ_DEFAULTS, onChange: () => undefined },
  parameters: {
    docs: {
      description: {
        component: 'Settings › Modules › DJ, each person’s Simple mode: Crossfade Off / Fixed / Auto, Length (2–12 s, only for Fixed), Beat-aligned, Gapless albums. Kept with the person (user_prefs), applied by the device that plays. An iOS home-screen app can’t mix, so it says Not on this device.',
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
