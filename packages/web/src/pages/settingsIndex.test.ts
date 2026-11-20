/**
 * Settings search: a static index of the labels each server section shows,
 * filtered to the sections the role can see (spec §3).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SETTINGS_INDEX, searchSettings } from './settingsIndex';
import { SERVER_SECTIONS, settingsNav } from './settingsSections';

const owner = settingsNav('owner');

describe('SETTINGS_INDEX', () => {
  it('every entry names a server section', () => {
    const sections = SERVER_SECTIONS.map((s) => s.value);
    for (const entry of SETTINGS_INDEX) expect(sections).toContain(entry.section);
  });
});

describe('Library care', () => {
  it('no entry for a Library care tab', () => {
    expect(SETTINGS_INDEX.filter((e) => e.section === 'genre-mapping' || e.section === 'activity')).toEqual([]);
    expect(searchSettings('genre', settingsNav('owner'))).toEqual([]);
  });
});

describe('searchSettings', () => {
  it('blank query lists every visible section', () => {
    const found = searchSettings('  ', owner);
    expect(found).toHaveLength(owner.length);
    expect(found.map((f) => f.section)).toEqual(owner.map((s) => s.value));
    for (const f of found) expect(f.matches).toEqual([]);
  });

  it('a row label finds its section', () => {
    expect(searchSettings('drop pool', owner)).toEqual([{ section: 'library', label: 'Library', matches: ['Drop pool'] }]);
  });

  it('case and word order do not matter', () => {
    expect(searchSettings('POOL drop', owner)).toEqual(searchSettings('drop pool', owner));
  });

  it('a section the role lacks is never found', () => {
    expect(searchSettings('backups', settingsNav('editor'))).toEqual([]);
    expect(searchSettings('drop pool', settingsNav('editor'))).toEqual([]);
  });

  it('a section label matches with no row', () => {
    const found = searchSettings('status', owner);
    expect(found[0]).toMatchObject({ section: 'status' });
    expect(found[0]!.matches).not.toContain('Status');
  });

  it('a straight apostrophe finds a curly one', () => {
    expect(searchSettings("what's new", owner)).toEqual([{ section: 'updates', label: 'Updates', matches: ['What\u2019s new'] }]);
  });

  it('nothing matches', () => {
    expect(searchSettings('zzz nothing', owner)).toEqual([]);
  });
});

/** The files each section renders (SettingsPage.tsx), read as text. */
const SECTION_FILES: Record<string, string[]> = {
  library: ['./SettingsScanRootsPage.tsx', '../components/naming/NamingSettings.tsx', '../components/naming/DropPoolSettings.tsx', './SettingsDeletingPage.tsx'],
  'tag-writing': ['./SettingsTagWritesPage.tsx'],
  following: ['./SettingsFollowRulesPage.tsx'],
};
const sourceOf = (section: string) => SECTION_FILES[section]!.map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');

describe('the index matches the pages', () => {
  for (const section of Object.keys(SECTION_FILES)) {
    it(`every indexed label is on its page: ${section}`, () => {
      const text = sourceOf(section);
      const labels = SETTINGS_INDEX.filter((e) => e.section === section).map((e) => e.label);
      expect(labels.length).toBeGreaterThan(1);
      const missing = labels.filter((l) => !text.includes(`title="${l}"`) && !text.includes(`label="${l}"`));
      expect(missing, `not on the ${section} page`).toEqual([]);
    });
  }

  it('search finds a row', () => {
    expect(searchSettings('separator', owner)).toEqual([{ section: 'tag-writing', label: 'Tag writing', matches: ['Separator'] }]);
    expect(searchSettings('auto-follow at', owner)).toEqual([{ section: 'following', label: 'Follow rules', matches: ['Auto-follow at'] }]);
    expect(searchSettings('folder link', owner)).toEqual([{ section: 'library', label: 'Library', matches: ['Folder link'] }]);
  });
});
