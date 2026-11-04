/**
 * The unreachable music folder notice: the owner sees it while the latest
 * scan of an enabled folder was aborted (LIB-5: it looked unmounted, or was
 * missing), until a scan finishes; never on Settings › Music folders.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MusicFolderNoticeView, showMusicFolderNotice, unreachableRoots } from './MusicFolderNotice';

const root = (path: string, lastStatus: string | null, enabled = true) => ({ path, lastStatus, enabled });

describe('unreachableRoots', () => {
  it('the enabled folders whose latest scan was aborted', () => {
    expect(unreachableRoots([root('/mnt/music', 'aborted'), root('/mnt/other', 'completed'), root('/mnt/off', 'aborted', false)])).toEqual(['/mnt/music']);
  });

  it('clears with the next scan that finishes', () => {
    expect(unreachableRoots([root('/mnt/music', 'completed')])).toEqual([]);
    expect(unreachableRoots([root('/mnt/music', null)])).toEqual([]);
    expect(unreachableRoots(undefined)).toEqual([]);
  });
});

describe('showMusicFolderNotice', () => {
  it('the owner, on every page but Settings › Music folders', () => {
    expect(showMusicFolderNotice({ role: 'owner' }, ['/mnt/music'], '/albums')).toBe(true);
    expect(showMusicFolderNotice({ role: 'owner' }, ['/mnt/music'], '/settings/library')).toBe(false);
    expect(showMusicFolderNotice({ role: 'owner' }, [], '/albums')).toBe(false);
  });

  it('nobody else', () => {
    expect(showMusicFolderNotice({ role: 'editor' }, ['/mnt/music'], '/albums')).toBe(false);
    expect(showMusicFolderNotice({ role: 'listener' }, ['/mnt/music'], '/albums')).toBe(false);
    expect(showMusicFolderNotice(undefined, ['/mnt/music'], '/albums')).toBe(false);
  });
});

describe('MusicFolderNoticeView', () => {
  it('a quiet warning: label, path, the way to Music folders', () => {
    const html = renderToStaticMarkup(<MusicFolderNoticeView paths={['/mnt/music']} action={<a href="/settings/library">Music folders</a>} />);
    expect(html).toContain('role="status"');
    expect(html).toMatch(/tone-warning/);
    expect(html).toContain('Music folder unreachable · /mnt/music · <a href="/settings/library">Music folders</a>');
    expect(renderToStaticMarkup(<MusicFolderNoticeView paths={['/a', '/b']} action={null} />)).toContain('Music folders unreachable · /a, /b');
    expect(renderToStaticMarkup(<MusicFolderNoticeView paths={[]} action={null} />)).toBe('');
  });
});
