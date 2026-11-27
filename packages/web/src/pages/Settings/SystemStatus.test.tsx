/**
 * Settings › Status › System status: the music share rows the updater
 * reports (spec section 11). The boot row is a problem with the suggested
 * fstab line behind "?"; a soft mount is a note; no updater, no row.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MusicBoot, UpdaterStatus, UpdaterView } from '@tagave/shared';
import { SystemStatusView, musicBootFrom } from './SystemStatus';

const FSTAB_LINE = '192.0.2.10:/export/music  /mnt/music  nfs4  hard,_netdev,nofail,x-systemd.automount,x-systemd.mount-timeout=30  0 0';

/** The text of every hint behind a `?` (HelpToggle's hidden region). */
const hidden = (html: string) => [...html.matchAll(/<div[^>]*hidden=""[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]).join('\n');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

const view = (musicBoot: MusicBoot | null | undefined) => renderToStaticMarkup(
  <SystemStatusView data={{ ok: true, checkedAt: '2026-11-28T08:00:00.000Z', checks: [] }} onRecheck={() => undefined} {...(musicBoot === undefined ? {} : { musicBoot })} />,
);

describe('the music share at boot row', () => {
  it('nofail missing: the row, its value as a problem, the fstab line behind "?"', () => {
    const html = view({ layout: 'direct', codes: ['nofail_missing'] });
    expect(text(html)).toContain('Music share at boot');
    expect(html).toMatch(/<span class="[^"]*problem[^"]*" role="alert">may stop this computer starting while the NAS is off<\/span>/);
    expect(html).toContain('aria-label="Help: Music share at boot"');
    const help = text(hidden(html));
    expect(help).toContain("Add nofail to the music share's line in /etc/fstab, for example:");
    expect(hidden(html)).toContain(FSTAB_LINE);
    // the line itself is not on the page until "?" opens
    expect(text(html.replace(/<div[^>]*hidden=""[^>]*>[\s\S]*?<\/div>/g, ''))).not.toContain('x-systemd.automount');
  });

  it('a soft mount: a note, never a problem', () => {
    const html = view({ layout: 'parent', codes: ['soft_mount'] });
    expect(text(html)).toContain('Music share mount');
    expect(text(html)).toContain('Mounted soft');
    expect(text(html)).not.toContain('Music share at boot');
    expect(html).not.toMatch(/problem|role="alert"/);
    expect(text(hidden(html))).toMatch(/soft mount.*cut a tag write short.*tagave suggests hard/);
  });

  it('both rows when both codes come', () => {
    const html = text(view({ layout: 'direct', codes: ['nofail_missing', 'soft_mount', 'automount_on'] }));
    expect(html).toContain('Music share at boot');
    expect(html).toContain('Mounted soft');
  });

  it('no row when the codes are empty or only automount_on', () => {
    for (const boot of [{ layout: 'direct', codes: [] }, { layout: 'parent', codes: ['automount_on'] }] satisfies MusicBoot[]) {
      const html = text(view(boot));
      expect(html).not.toContain('Music share');
    }
  });

  it('no row and no placeholder without the updater', () => {
    for (const boot of [null, undefined]) {
      const html = text(view(boot));
      expect(html).not.toMatch(/Music share|NAS|fstab/);
    }
  });
});

describe('musicBootFrom', () => {
  const status = (musicBoot?: MusicBoot | null): UpdaterStatus => ({
    version: '0.39.0', configuredVersion: '0.39.0', role: 'all', services: [], run: null,
    ...(musicBoot === undefined ? {} : { musicBoot }),
  });
  const v = (over: Partial<UpdaterView>): UpdaterView => ({ installed: true, reachable: true, error: null, updater: status({ layout: 'direct', codes: ['nofail_missing'] }), ...over });

  it("the updater's reading when it answers", () => {
    expect(musicBootFrom(v({}))).toEqual({ layout: 'direct', codes: ['nofail_missing'] });
  });

  it('null without the updater, when it does not answer, or from an older one', () => {
    expect(musicBootFrom(undefined)).toBeNull();
    expect(musicBootFrom(v({ installed: false, reachable: false, updater: null }))).toBeNull();
    // the last answer kept while the updater restarts itself
    expect(musicBootFrom(v({ reachable: false }))).toBeNull();
    expect(musicBootFrom(v({ updater: status() }))).toBeNull();
    expect(musicBootFrom(v({ updater: status(null) }))).toBeNull();
  });
});
