/**
 * Your settings › Appearance: the theme (with the light and dark switch) and
 * the display prefs, the same for everyone, as groups (spec §6): Theme,
 * Sidebar, Albums, Artists, Player. Every choice applies at once and shows no
 * `✓ Saved`: a display pref is this device's and is seen as it changes; the
 * theme, which follows the person between devices, says `Not saved` when its
 * save fails (ThemeSetting). The curation switch lives in Library care's
 * header (spec §4).
 */
import type { ReactNode } from 'react';
import { Button, SegmentedControl, Select, SettingsGroup, SettingsRow } from '../components/ui';
import { useDisplayPrefs } from '../displayPrefs';
import { ALBUM_WIDGETS, DEFAULT_ALBUM_WIDGETS, type WidgetPlacement } from './albumWidgets';
import { ThemeSetting } from '../themes/ThemeSetting';

export function YouAppearance() {
  return <YouAppearanceView theme={<ThemeSetting />} />;
}

/**
 * The section with its Theme group given (stories pass a ThemeGroup around
 * the gallery alone, no saving to the server). The rest reads this
 * browser's own prefs.
 */
export function YouAppearanceView({ theme }: { theme: ReactNode }) {
  return <>
    {theme}
    <DisplaySettings />
  </>;
}

/**
 * Sidebar, album, artist and player display: whether the desktop sidebar
 * stays or hides (Auto-hide, components/sidebarPeek.ts), where the search
 * sits, the wordmark, the artwork under short albums and where each detail
 * sits in an album's header (the album page's Customize lands on
 * #album-widgets), the artist page's layout, the equalizer glow.
 */
function DisplaySettings() {
  const [prefs, setPrefs] = useDisplayPrefs();
  return <>
    <SettingsGroup title="Sidebar">
      <SettingsRow as="div" label="Sidebar">
        <SegmentedControl label="Sidebar" value={prefs.sidebarAutoHide ? 'autoHide' : 'always'} onChange={(v) => setPrefs({ sidebarAutoHide: v === 'autoHide' })} options={[{ value: 'always', label: 'Always' }, { value: 'autoHide', label: 'Auto-hide' }]} />
      </SettingsRow>
      <SettingsRow as="div" label="Search box">
        <SegmentedControl label="Search box" value={prefs.searchPlacement} onChange={(v) => setPrefs({ searchPlacement: v })} options={[{ value: 'below', label: 'Below' }, { value: 'beside', label: 'Beside' }]} />
      </SettingsRow>
      <SettingsRow as="div" label="Wordmark">
        <SegmentedControl label="Wordmark" value={prefs.showWordmark ? 'shown' : 'hidden'} onChange={(v) => setPrefs({ showWordmark: v === 'shown' })} options={[{ value: 'shown', label: 'Shown' }, { value: 'hidden', label: 'Hidden' }]} />
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup
      id="album-widgets"
      title="Albums"
      after={<div><Button variant="quiet" size="sm" onClick={() => setPrefs({ albumWidgets: DEFAULT_ALBUM_WIDGETS })}>Restore defaults</Button></div>}
    >
      <SettingsRow as="div" label="Short albums">
        <SegmentedControl label="Short album artwork" value={prefs.shortAlbumArt ? prefs.shortAlbumWaves ? 'waves' : 'still' : 'off'}
          onChange={(v) => setPrefs({ shortAlbumArt: v !== 'off', shortAlbumWaves: v === 'waves' })}
          options={[{ value: 'still', label: 'Still' }, { value: 'waves', label: 'Waves' }, { value: 'off', label: 'Off' }]} />
      </SettingsRow>
      {ALBUM_WIDGETS.map(({ id, label }) => (
        <SettingsRow key={id} as="div" label={label}>
          <Select dense aria-label={label} value={prefs.albumWidgets[id]} onChange={(event) => setPrefs({
            albumWidgets: { ...prefs.albumWidgets, [id]: event.target.value as WidgetPlacement },
          })}>
            <option value="above">Above the title</option>
            <option value="below">Below the artist</option>
            <option value="hidden">Hidden</option>
          </Select>
        </SettingsRow>
      ))}
    </SettingsGroup>
    <SettingsGroup title="Artists">
      <SettingsRow as="div" label="Artist page">
        <SegmentedControl label="Artist page" value={prefs.artistLayout} onChange={(v) => setPrefs({ artistLayout: v })} options={[{ value: 'name', label: 'Name first' }, { value: 'albums', label: 'Like albums' }]} />
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup title="Player">
      <SettingsRow as="div" label="Equalizer glow">
        <SegmentedControl label="Equalizer glow" value={prefs.eqGlow ? 'on' : 'off'} onChange={(v) => setPrefs({ eqGlow: v === 'on' })} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} />
      </SettingsRow>
    </SettingsGroup>
  </>;
}
