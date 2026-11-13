import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { LidarrRootCheckView, LidarrSettingsView } from '@tagave/shared';
import { LidarrSettingsForm, draftOf } from '../components/LidarrSettings';

const ROOT = '11111111-1111-4111-8111-111111111111';
const view: LidarrSettingsView = {
  enabled: true,
  connection: {
    url: 'http://lidarr:8686',
    keySaved: true,
    keyUnreadable: false,
    rootFolderPath: '/data/music/_Inbox',
    qualityProfileId: 2,
    metadataProfileId: 1,
    version: '2.9.6.4552',
    qualityProfileName: 'Lossless',
    metadataProfileName: 'Standard',
    useDropPool: true,
    pathMap: { lidarrPath: '/data/music', scanRootId: ROOT },
  },
  scanRoots: ['/mnt/music'],
  musicFolders: [{ id: ROOT, path: '/mnt/music', hostPath: null }],
  pool: { scanRootId: ROOT, dirPath: '_Inbox', path: '/mnt/music/_Inbox', lidarrPath: '/data/music/_Inbox' },
  rootFolderOutside: false,
  open: 2,
};
const check = (reach: LidarrRootCheckView['reach']): LidarrRootCheckView => ({ reach, path: '/data/music/_Inbox', mountPath: '/data/music', error: null });
const noop = () => undefined;

function Form({ v = view, rootCheck }: { v?: LidarrSettingsView; rootCheck: LidarrRootCheckView | null }) {
  const [draft, setDraft] = useState(() => draftOf(v));
  return <LidarrSettingsForm view={v} draft={draft} tested={null} error={null} onChange={setDraft} onTest={noop} onSave={noop} onDisconnect={noop} rootCheck={rootCheck} />;
}

const meta = {
  title: 'Settings/Modules/Lidarr',
  parameters: {
    docs: {
      description: {
        component: 'Settings › Modules › Lidarr: the connection, Use the drop pool (tagave makes the pool Lidarr’s root folder), the path mapping (Lidarr sees the music folder as …) and one line saying whether Lidarr can write in its root folder, or where its container needs the music share.',
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
export const CantSeePhone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <Form rootCheck={check('unseen')} /> };
export const CanWritePhone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <Form rootCheck={check('writable')} /> };
