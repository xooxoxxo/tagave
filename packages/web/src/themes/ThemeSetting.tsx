/**
 * Your settings › Appearance › Theme, connected: the Theme group (the light
 * and dark switch as its row), then the gallery on the person's choice (it
 * follows them between devices, ThemeColours.tsx) and Custom's editor under
 * the cards on a desktop. On a phone Custom is a screen of its own
 * (/you/custom-theme, CustomThemeScreen).
 */
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { ThemeId, ThemeSpec } from '@tagave/shared';
import { SaveStatus, SettingsGroup, SettingsRow, ThemeSwitch } from '../components/ui';
import { useResolvedDark } from '../adaptive/AdaptiveColour';
import { PHONE_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { CUSTOM_START } from './engine';
import { CustomEditor, ThemeGallery } from './ThemePicker';
import { useThemeChoice, useThemeSaveFailed } from './ThemeColours';

export const CUSTOM_THEME_SECTION = 'custom-theme';

/**
 * The Theme group with the gallery given (stories pass it on local state).
 * The switch applies at once on this device; the theme shows `Not saved`
 * only when its save to the server failed.
 */
export function ThemeGroup({ failed = false, children }: { failed?: boolean; children: ReactNode }) {
  return (
    <SettingsGroup title="Theme" status={failed ? <SaveStatus state="failed" /> : null} after={children}>
      <SettingsRow as="div" label="Light and dark"><ThemeSwitch /></SettingsRow>
    </SettingsGroup>
  );
}

export function ThemeSetting() {
  const [choice, setChoice] = useThemeChoice();
  const failed = useThemeSaveFailed();
  const dark = useResolvedDark();
  const phone = useMediaQuery(PHONE_QUERY);
  const navigate = useNavigate();
  const pick = (id: ThemeId) => setChoice({ theme: id, custom: id === 'custom' ? choice.custom ?? CUSTOM_START : choice.custom });
  const edit = (spec: ThemeSpec) => setChoice({ theme: 'custom', custom: spec });
  return (
    <ThemeGroup failed={failed}>
      <ThemeGallery
        choice={choice} dark={dark} onPick={pick}
        onCustom={phone ? () => void navigate({ to: '/you/$section', params: { section: CUSTOM_THEME_SECTION } }) : undefined}
      />
      {!phone && choice.theme === 'custom' && <CustomEditor spec={choice.custom ?? CUSTOM_START} dark={dark} onChange={edit} />}
    </ThemeGroup>
  );
}

/** Custom on a phone: the editor over its own live preview. */
export function CustomThemeScreen() {
  const [choice, setChoice] = useThemeChoice();
  const dark = useResolvedDark();
  const phone = useMediaQuery(PHONE_QUERY);
  return <CustomEditor spec={choice.custom ?? CUSTOM_START} dark={dark} phone={phone} onChange={(spec) => setChoice({ theme: 'custom', custom: spec })} />;
}
