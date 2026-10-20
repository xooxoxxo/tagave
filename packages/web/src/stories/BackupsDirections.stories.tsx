import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { DirectionA } from './backups-directions/DirectionA';
import { DirectionB } from './backups-directions/DirectionB';

/** The settings content column: the section heading and an 850px pane. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: 'clamp(16px, 4vw, 40px)', background: 'var(--canvas)', minHeight: '100vh', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 850, display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <h2 style={{ margin: 0, font: 'var(--type-title)', fontSize: '1.5rem', color: 'var(--ink)' }}>Backups</h2>
        {children}
      </div>
    </div>
  );
}

const meta = {
  title: 'Previews/Backups directions',
  // design previews for a pick, not baselines
  tags: ['no-shot', '!autodocs'],
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const A_SettingsRows: Story = { name: 'A · Settings rows', render: () => <Frame><DirectionA /></Frame> };
export const B_ScheduleList: Story = { name: 'B · Schedule + list', render: () => <Frame><DirectionB /></Frame> };
export const B_EditSheet: Story = { name: 'B · Edit sheet', render: () => <Frame><DirectionB editing /></Frame> };
