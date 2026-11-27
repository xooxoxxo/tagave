import { describe, expect, it } from 'vitest';
import { rescanNote } from './AlbumMaintenanceActions';

const q = (n: number) => Array.from({ length: n }, (_, i) => ({ scanRootId: 'r', dirPath: `d${i}`, jobId: 'j', alreadyQueued: false }));

describe('the note after Rescan folder', () => {
  it('says the scan is queued for the folder\'s return when the API says it waits', () => {
    expect(rescanNote({ queued: q(1), waiting: true })).toBe('Scan queued. It runs when the folder is back.');
    expect(rescanNote({ queued: q(2), waiting: true })).toBe('Scan queued. It runs when the folder is back.');
  });

  it('says how many folders it rescans when every folder is online', () => {
    expect(rescanNote({ queued: q(1) })).toBe('Rescanning 1 folder. The page updates as files are re-read.');
    expect(rescanNote({ queued: q(3) })).toBe('Rescanning 3 folders. The page updates as files are re-read.');
  });
});
