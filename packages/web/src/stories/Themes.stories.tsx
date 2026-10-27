import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { ThemeChoice, ThemeId, ThemeSpec } from '@tagave/shared';
import { CustomEditor, ThemeGallery } from '../themes/ThemePicker';
import { CUSTOM_START, generate, generatedSpec, seedFromHue } from '../themes/engine';

/** The toolbar's mode (data-theme on <html>). */
function useStoryDark(): boolean {
  return useSyncExternalStore((cb) => {
    const mo = new MutationObserver(cb);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, () => document.documentElement.getAttribute('data-theme') === 'dark');
}

/** A Custom the person made: a green, a coral second accent for the player. */
const CUSTOM: ThemeSpec = { seed: seedFromHue(165), accent2: '#e0573f' };

interface Args { theme: ThemeId; editor: boolean; phone: boolean }

/** Settings › Appearance › Theme as the app shows it: the page in the picked theme. */
function Picker({ theme, editor, phone }: Args) {
  const dark = useStoryDark();
  const [choice, setChoice] = useState<ThemeChoice>({ theme, custom: CUSTOM });
  const spec = generatedSpec(choice);
  const page = useMemo(() => ({ ...(spec ? generate(spec, dark).tokens : {}), background: 'var(--canvas)', color: 'var(--ink)', padding: phone ? 16 : 24, display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 850, minHeight: phone ? '100vh' : undefined }) as CSSProperties, [spec, dark, phone]);
  const pick = (id: ThemeId) => setChoice((c) => ({ theme: id, custom: c.custom }));
  const edit = (custom: ThemeSpec) => setChoice({ theme: 'custom', custom });
  return (
    <div style={page}>
      {phone && editor
        ? <CustomEditor spec={choice.custom ?? CUSTOM_START} dark={dark} onChange={edit} phone />
        : <>
          <ThemeGallery choice={choice} dark={dark} onPick={pick} />
          {editor && choice.theme === 'custom' && <CustomEditor spec={choice.custom ?? CUSTOM_START} dark={dark} onChange={edit} />}
        </>}
    </div>
  );
}

const meta = {
  title: 'Settings/Theme',
  component: Picker,
  args: { theme: 'moody', editor: false, phone: false },
  argTypes: { theme: { control: 'inline-radio', options: ['adaptive', 'classic', 'moody', 'mono', 'custom'] } },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Settings › Appearance › Theme: a card per starter with a live mini preview (Adaptive shows three covers), picked for the person and following them between devices. Custom opens an editor under the cards: a colour (native picker and hex), its hue, an optional second accent for the player, the lowest text contrast. On a phone the editor is a screen of its own. Adaptive and Classic keep the brand tokens.',
      },
    },
  },
} satisfies Meta<typeof Picker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {};
export const GalleryAdaptive: Story = { name: 'Gallery, Adaptive', args: { theme: 'adaptive' } };
export const Custom: Story = { name: 'Custom editor', args: { theme: 'custom', editor: true } };
export const GalleryPhone: Story = { name: 'Gallery, phone', tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { theme: 'mono', phone: true } };
export const CustomPhone: Story = { name: 'Custom editor, phone', tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { theme: 'custom', editor: true, phone: true } };
