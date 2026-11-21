import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { LidarrRootCheckView, LidarrSettingsView } from '@tagave/shared';
import { LidarrSettingsForm, draftOf } from '../components/LidarrSettings';
import { LIDARR_VIEW } from './lidarrFixtures';

const view = LIDARR_VIEW;
const check = (reach: LidarrRootCheckView['reach']): LidarrRootCheckView => ({ reach, path: '/data/music/_Inbox', mountPath: '/data/music', error: null });
const noop = () => undefined;

function Form({ v = view, rootCheck, error = null }: { v?: LidarrSettingsView; rootCheck: LidarrRootCheckView | null; error?: string | null }) {
  const [draft, setDraft] = useState(() => draftOf(v));
  return <LidarrSettingsForm view={v} draft={draft} tested={null} error={error} onChange={setDraft} onTest={noop} onSave={noop} onDisconnect={noop} rootCheck={rootCheck} />;
}

const meta = {
  title: 'Settings/Modules/Lidarr',
  parameters: {
    docs: {
      description: {
        component: 'Settings › Modules › Lidarr, under its Module group and only while Lidarr is on: Connection (URL, API key, Test), then Library (Use the drop pool, the root folder, the profiles, the path mapping, whether Lidarr can write in its root folder) and one Save for the whole connection.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 850, padding: 24 }}><Story /></div>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const CanWrite: Story = { render: () => <Form rootCheck={check('writable')} /> };
export const CantSee: Story = { render: () => <Form rootCheck={check('unseen')} /> };
export const CantWrite: Story = { render: () => <Form rootCheck={check('readonly')} /> };
/** Lidarr and tagave share paths: no mapping, the root folder picked from Lidarr's. */
export const SamePaths: Story = {
  render: () => <Form
    v={{ ...view, pool: null, connection: { ...view.connection!, rootFolderPath: '/mnt/music', useDropPool: false, pathMap: null } }}
    rootCheck={{ reach: 'writable', path: '/mnt/music', mountPath: '/mnt/music', error: null }}
  />,
};
/** A Save that failed: the server's sentence beside Save. */
export const NotSaved: Story = { name: 'Not saved', render: () => <Form rootCheck={check('writable')} error="Lidarr did not answer" /> };
/** A new connection: Connection only until Test finds the folders and profiles. */
export const NewConnection: Story = { name: 'New connection', render: () => <Form v={{ ...view, connection: null }} rootCheck={null} /> };
export const NewConnectionPhone: Story = { name: 'New connection, phone', tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <Form v={{ ...view, connection: null }} rootCheck={null} /> };
export const CantSeePhone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <Form rootCheck={check('unseen')} /> };
export const CanWritePhone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <Form rootCheck={check('writable')} /> };
