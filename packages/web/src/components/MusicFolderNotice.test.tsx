/**
 * The music folder notice: the owner sees it while a music folder cannot be
 * reached (LIB-5: it looked unmounted, or was missing), "Reconnecting" while
 * the updater mounts it again; never on Settings › Music folders.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MusicFolderNoticeView, showMusicFolderNotice, type MusicFolderNoticeState } from './MusicFolderNotice';

const unreachable: MusicFolderNoticeState = { kind: 'unreachable', paths: ['/mnt/music'] };

describe('showMusicFolderNotice', () => {
  it('the owner, on every page but Settings › Music folders', () => {
    expect(showMusicFolderNotice({ role: 'owner' }, unreachable, '/albums')).toBe(true);
    expect(showMusicFolderNotice({ role: 'owner' }, { kind: 'healing' }, '/albums')).toBe(true);
    expect(showMusicFolderNotice({ role: 'owner' }, unreachable, '/settings/library')).toBe(false);
    expect(showMusicFolderNotice({ role: 'owner' }, { kind: 'none' }, '/albums')).toBe(false);
    expect(showMusicFolderNotice({ role: 'owner' }, undefined, '/albums')).toBe(false);
  });

  it('nobody else', () => {
    expect(showMusicFolderNotice({ role: 'editor' }, unreachable, '/albums')).toBe(false);
    expect(showMusicFolderNotice({ role: 'listener' }, unreachable, '/albums')).toBe(false);
    expect(showMusicFolderNotice(undefined, unreachable, '/albums')).toBe(false);
  });
});

describe('MusicFolderNoticeView', () => {
  it('unreachable: a quiet warning, label, path, the way to Music folders', () => {
    const html = renderToStaticMarkup(<MusicFolderNoticeView state={unreachable} action={<a href="/settings/library">Music folders</a>} />);
    expect(html).toContain('role="status"');
    expect(html).toMatch(/tone-warning/);
    expect(html).toContain('Music folder unreachable · /mnt/music · <a href="/settings/library">Music folders</a>');
    expect(renderToStaticMarkup(<MusicFolderNoticeView state={{ kind: 'unreachable', paths: ['/a', '/b'] }} action={null} />)).toContain('Music folders unreachable · /a, /b');
  });

  it('healing: one label, no link', () => {
    const html = renderToStaticMarkup(<MusicFolderNoticeView state={{ kind: 'healing' }} action={<a href="/settings/library">Music folders</a>} />);
    expect(html).toContain('Reconnecting music folder');
    expect(html).not.toContain('href');
  });

  it('nothing to say: nothing', () => {
    expect(renderToStaticMarkup(<MusicFolderNoticeView state={{ kind: 'none' }} action={null} />)).toBe('');
  });
});
