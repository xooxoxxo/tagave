/**
 * The music folder notice: the owner sees it while a music folder is offline
 * or not connected ("since 14:02"), "Reconnecting" while the updater mounts
 * it again; never on Settings › Music folders. An API older than 0097 still
 * answers `unreachable` with paths, and reads as before.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MusicFolderResponse, MusicFolderView } from '@tagave/shared';
import { MusicFolderNoticeView, noticeText, showMusicFolderNotice } from './MusicFolderNotice';

const now = new Date('2026-11-24T16:00:00');
const f = (over: Partial<MusicFolderView>): MusicFolderView => ({
  id: 'r1', name: 'Music', path: '/mnt/music', reach: 'offline', since: '2026-11-24T14:02:00', reason: 'server_silent',
  waiting: { scans: 0, tagWrites: 0, other: 0 }, ...over,
});
const offline: MusicFolderResponse = { kind: 'offline', folders: [f({})] };
const healing: MusicFolderResponse = { kind: 'healing', folders: [] };
const none: MusicFolderResponse = { kind: 'none', folders: [] };
const legacy = { kind: 'unreachable', paths: ['/mnt/music'] } as never as MusicFolderResponse;

describe('noticeText', () => {
  it.each([
    [{ kind: 'offline', folders: [f({ reach: 'offline', since: '2026-11-24T14:02:00' })] }, 'Music folder offline since 14:02'],
    [{ kind: 'offline', folders: [f({ reach: 'unmounted', since: '2026-11-24T14:02:00' })] }, 'Music folder not connected since 14:02'],
    [{ kind: 'offline', folders: [f({}), f({})] }, '2 music folders offline'],
    [{ kind: 'healing', folders: [] }, 'Reconnecting music folder'],
    [{ kind: 'offline', folders: [f({ since: '2026-11-23T09:10:00' })] }, 'Music folder offline since 23 Nov, 09:10'],
  ])('%#', (s, text) => expect(noticeText(s as MusicFolderResponse, now)).toBe(text));

  it('reads an older API answer as before', () => expect(noticeText({ kind: 'unreachable', paths: ['/mnt/music'] } as never, now)).toBe('Music folder unreachable · /mnt/music'));
  it('an older API answer, several folders', () => expect(noticeText({ kind: 'unreachable', paths: ['/a', '/b'] } as never, now)).toBe('Music folders unreachable · /a, /b'));
  it('no reading yet: no time', () => expect(noticeText({ kind: 'offline', folders: [f({ since: null })] }, now)).toBe('Music folder offline'));
  it('nothing to say: nothing', () => expect(noticeText(none, now)).toBeNull());
});

describe('showMusicFolderNotice', () => {
  it('the owner, on every page but Settings › Music folders', () => {
    expect(showMusicFolderNotice({ role: 'owner' }, offline, '/albums')).toBe(true);
    expect(showMusicFolderNotice({ role: 'owner' }, legacy, '/albums')).toBe(true);
    expect(showMusicFolderNotice({ role: 'owner' }, healing, '/albums')).toBe(true);
    expect(showMusicFolderNotice({ role: 'owner' }, offline, '/settings/library')).toBe(false);
    expect(showMusicFolderNotice({ role: 'owner' }, none, '/albums')).toBe(false);
    expect(showMusicFolderNotice({ role: 'owner' }, undefined, '/albums')).toBe(false);
  });

  it('nobody else', () => {
    expect(showMusicFolderNotice({ role: 'editor' }, offline, '/albums')).toBe(false);
    expect(showMusicFolderNotice({ role: 'listener' }, offline, '/albums')).toBe(false);
    expect(showMusicFolderNotice(undefined, offline, '/albums')).toBe(false);
  });
});

describe('MusicFolderNoticeView', () => {
  const link = <a href="/settings/library">Music folders</a>;

  it('offline: a quiet warning, since when, the way to Music folders', () => {
    const html = renderToStaticMarkup(<MusicFolderNoticeView state={offline} now={now} action={link} />);
    expect(html).toContain('role="status"');
    expect(html).toMatch(/tone-warning/);
    expect(html).toContain('Music folder offline since 14:02 · <a href="/settings/library">Music folders</a>');
  });

  it('several: how many, the way to Music folders', () => {
    const html = renderToStaticMarkup(<MusicFolderNoticeView state={{ kind: 'offline', folders: [f({}), f({ id: 'r2', path: '/mnt/vinyl' })] }} now={now} action={link} />);
    expect(html).toMatch(/tone-warning/);
    expect(html).toContain('2 music folders offline · <a href="/settings/library">Music folders</a>');
  });

  it('an older API answer: as before', () => {
    const html = renderToStaticMarkup(<MusicFolderNoticeView state={legacy} now={now} action={link} />);
    expect(html).toContain('Music folder unreachable · /mnt/music · <a href="/settings/library">Music folders</a>');
  });

  it('healing: one label, no link', () => {
    const html = renderToStaticMarkup(<MusicFolderNoticeView state={healing} now={now} action={link} />);
    expect(html).toMatch(/tone-info/);
    expect(html).toContain('Reconnecting music folder');
    expect(html).not.toContain('href');
  });

  it('nothing to say: nothing', () => {
    expect(renderToStaticMarkup(<MusicFolderNoticeView state={none} action={null} />)).toBe('');
  });
});
