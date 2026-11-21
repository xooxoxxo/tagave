/** Settings › Modules › Lidarr fixtures: a saved connection that uses the drop pool. */
import type { LidarrSettingsView } from '@tagave/shared';

export const LIDARR_ROOT = '11111111-1111-4111-8111-111111111111';

export const LIDARR_VIEW: LidarrSettingsView = {
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
    pathMap: { lidarrPath: '/data/music', scanRootId: LIDARR_ROOT },
  },
  scanRoots: ['/mnt/music'],
  musicFolders: [{ id: LIDARR_ROOT, path: '/mnt/music', hostPath: null }],
  pool: { scanRootId: LIDARR_ROOT, dirPath: '_Inbox', path: '/mnt/music/_Inbox', lidarrPath: '/data/music/_Inbox' },
  rootFolderOutside: false,
  open: 2,
};
