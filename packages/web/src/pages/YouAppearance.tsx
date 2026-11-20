/**
 * Your settings › Appearance: the light and dark switch, the theme and the
 * display prefs, the same for everyone. The curation switch lives in Library
 * care's header (spec §4).
 */
import type { ReactNode } from 'react';
import { Button, SegmentedControl, Select, ThemeSwitch } from '../components/ui';
import { useDisplayPrefs } from '../displayPrefs';
import { ALBUM_WIDGETS, DEFAULT_ALBUM_WIDGETS, type WidgetPlacement } from './albumWidgets';
import { ThemeSetting } from '../themes/ThemeSetting';
import styles from './SettingsPage.module.css';

export function YouAppearance() {
  return <YouAppearanceView theme={<ThemeSetting headingClassName={styles.modeSetting} />} />;
}

/**
 * The section with its theme picker given (stories pass the gallery alone,
 * no saving to the server). The rest reads this browser's own prefs.
 */
export function YouAppearanceView({ theme }: { theme: ReactNode }) {
  return <>
    <ThemeSwitch />
    {theme}
    <DisplaySettings />
  </>;
}

/**
 * Sidebar, album and artist display: whether the desktop sidebar stays or
 * hides (Auto-hide, components/sidebarPeek.ts), where the search sits, the wordmark,
 * the artwork under short albums, and the artist page's layout. Each is its own setting with the same rhythm
 * as Appearance above.
 */
function DisplaySettings() {
  const [prefs, setPrefs] = useDisplayPrefs();
  return <>
    <h2 className={styles.modeSetting}>Sidebar</h2>
    <SegmentedControl label="Sidebar" value={prefs.sidebarAutoHide ? 'autoHide' : 'always'} onChange={(v) => setPrefs({ sidebarAutoHide: v === 'autoHide' })} options={[{ value: 'always', label: 'Always' }, { value: 'autoHide', label: 'Auto-hide' }]} />
    <h2 className={styles.modeSetting}>Search box</h2>
    <SegmentedControl label="Search box" value={prefs.searchPlacement} onChange={(v) => setPrefs({ searchPlacement: v })} options={[{ value: 'below', label: 'Below' }, { value: 'beside', label: 'Beside' }]} />
    <h2 className={styles.modeSetting}>Wordmark</h2>
    <SegmentedControl label="Wordmark" value={prefs.showWordmark ? 'shown' : 'hidden'} onChange={(v) => setPrefs({ showWordmark: v === 'shown' })} options={[{ value: 'shown', label: 'Shown' }, { value: 'hidden', label: 'Hidden' }]} />
    <h2 className={styles.modeSetting}>Short albums</h2>
    <SegmentedControl label="Short album artwork" value={prefs.shortAlbumArt ? prefs.shortAlbumWaves ? 'waves' : 'still' : 'off'}
      onChange={(v) => setPrefs({ shortAlbumArt: v !== 'off', shortAlbumWaves: v === 'waves' })}
      options={[{ value: 'still', label: 'Still' }, { value: 'waves', label: 'Waves' }, { value: 'off', label: 'Off' }]} />
    <section id="album-widgets" aria-labelledby="album-widgets-title" className={styles.widgetSettings}>
      <h2 id="album-widgets-title" className={styles.modeSetting}>Album header</h2>
      <div className={styles.widgetChoices}>
        {ALBUM_WIDGETS.map(({ id, label }) => <label key={id}>
          <span>{label}</span>
          <Select dense value={prefs.albumWidgets[id]} onChange={(event) => setPrefs({
            albumWidgets: { ...prefs.albumWidgets, [id]: event.target.value as WidgetPlacement },
          })}>
            <option value="above">Above the title</option>
            <option value="below">Below the artist</option>
            <option value="hidden">Hidden</option>
          </Select>
        </label>)}
      </div>
      <Button variant="quiet" size="sm" onClick={() => setPrefs({ albumWidgets: DEFAULT_ALBUM_WIDGETS })}>Restore defaults</Button>
    </section>
    <h2 className={styles.modeSetting}>Artist page</h2>
    <SegmentedControl label="Artist page" value={prefs.artistLayout} onChange={(v) => setPrefs({ artistLayout: v })} options={[{ value: 'name', label: 'Name first' }, { value: 'albums', label: 'Like albums' }]} />
    <h2 className={styles.modeSetting}>Equalizer glow</h2>
    <SegmentedControl label="Equalizer glow" value={prefs.eqGlow ? 'on' : 'off'} onChange={(v) => setPrefs({ eqGlow: v === 'on' })} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
  </>;
}
