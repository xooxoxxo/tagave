/**
 * Settings › Appearance › Theme, connected: the gallery on the person's
 * choice (it follows them between devices, ThemeColours.tsx), Custom's
 * editor under the cards on a desktop. On a phone Custom is a screen of its
 * own (/settings/custom-theme, CustomThemeScreen).
 */
import { useNavigate } from '@tanstack/react-router';
import type { ThemeId, ThemeSpec } from '@tagave/shared';
import { useResolvedDark } from '../adaptive/AdaptiveColour';
import { PHONE_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { CUSTOM_START } from './engine';
import { CustomEditor, ThemeGallery } from './ThemePicker';
import { useThemeChoice } from './ThemeColours';

export const CUSTOM_THEME_SECTION = 'custom-theme';

export function ThemeSetting({ headingClassName }: { headingClassName?: string | undefined }) {
  const [choice, setChoice] = useThemeChoice();
  const dark = useResolvedDark();
  const phone = useMediaQuery(PHONE_QUERY);
  const navigate = useNavigate();
  const pick = (id: ThemeId) => setChoice({ theme: id, custom: id === 'custom' ? choice.custom ?? CUSTOM_START : choice.custom });
  const edit = (spec: ThemeSpec) => setChoice({ theme: 'custom', custom: spec });
  return (
    <>
      <h2 className={headingClassName}>Theme</h2>
      <ThemeGallery
        choice={choice} dark={dark} onPick={pick}
        onCustom={phone ? () => void navigate({ to: '/settings/$section', params: { section: CUSTOM_THEME_SECTION } }) : undefined}
      />
      {!phone && choice.theme === 'custom' && <CustomEditor spec={choice.custom ?? CUSTOM_START} dark={dark} onChange={edit} />}
    </>
  );
}

/** Custom on a phone: the editor over its own live preview. */
export function CustomThemeScreen() {
  const [choice, setChoice] = useThemeChoice();
  const dark = useResolvedDark();
  const phone = useMediaQuery(PHONE_QUERY);
  return <CustomEditor spec={choice.custom ?? CUSTOM_START} dark={dark} phone={phone} onChange={(spec) => setChoice({ theme: 'custom', custom: spec })} />;
}
