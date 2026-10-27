/**
 * Settings › Appearance › Theme: a gallery of the starters, each card a live
 * mini preview of the app in that theme, and Custom's editor (a colour, its
 * hue, an optional second accent for the player, the lowest contrast). Pure
 * views: ThemeSetting.tsx connects them to the person's choice.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Input, SegmentedControl } from '../components/ui';
import { THEME_LABELS, THEME_ORDER, brandMiniTokens, generate, generatedSpec, hctOf, hueTrack, minRatios, seedFromHue, withHue, CUSTOM_START, type ThemeChoice, type ThemeId, type ThemeSpec } from './engine';
import s from './ThemePicker.module.css';

/** The covers the Adaptive card samples: three very different source colours. */
const ADAPTIVE_SAMPLES: ThemeSpec[] = [{ seed: '#1b1a2d' }, { seed: '#ffd400' }, { seed: '#e10600' }];

function miniStyle(spec: ThemeSpec | null, dark: boolean): CSSProperties {
  return (spec ? generate(spec, dark).tokens : brandMiniTokens(dark)) as CSSProperties;
}

function MiniBody({ style }: { style: CSSProperties }) {
  return (
    <span className={s.miniBody} style={style}>
      <span className={s.miniSide}><i /><i /><i data-on="" /></span>
      <span className={s.miniMain}>
        <span className={s.miniCover} />
        <span className={s.miniLines}><i /><i /><b /></span>
      </span>
      <span className={s.miniBar}><i /><span className={s.miniSeek}><i /></span></span>
    </span>
  );
}

/** A tiny app (sidebar, lines, a key, the player bar) in a theme's tokens; Adaptive shows three covers' accents. */
export function MiniTheme({ id, spec, dark, large = false }: { id: ThemeId; spec: ThemeSpec | null; dark: boolean; large?: boolean }) {
  const styles = useMemo(
    () => (id === 'adaptive' ? ADAPTIVE_SAMPLES.map((sp) => miniStyle(sp, dark)) : [miniStyle(spec, dark)]),
    [id, spec, dark],
  );
  return (
    <span className={`${s.mini} ${large ? s.miniLg : ''}`} aria-hidden="true">
      {id === 'adaptive'
        ? <span className={s.miniSplit}>{styles.map((st, i) => <MiniBody key={i} style={st} />)}</span>
        : <MiniBody style={styles[0]!} />}
    </span>
  );
}

export interface ThemeGalleryProps {
  choice: ThemeChoice;
  dark: boolean;
  onPick: (id: ThemeId) => void;
  /** a click on Custom, picked or not (a phone opens its screen) */
  onCustom?: (() => void) | undefined;
}

/** The starters as radio cards. */
export function ThemeGallery({ choice, dark, onPick, onCustom }: ThemeGalleryProps) {
  return (
    <div role="radiogroup" aria-label="Theme" className={s.gallery}>
      {THEME_ORDER.map((id) => {
        const spec = id === 'custom' ? choice.custom ?? CUSTOM_START : generatedSpec({ theme: id, custom: null });
        const on = choice.theme === id;
        return (
          <label key={id} className={s.card} data-on={on || undefined}>
            <input
              type="radio" name="theme" value={id} className={s.radio} checked={on}
              onChange={() => onPick(id)}
              onClick={id === 'custom' ? onCustom : undefined}
            />
            <MiniTheme id={id} spec={spec} dark={dark} />
            <span className={s.cardName}>{THEME_LABELS[id]}</span>
          </label>
        );
      })}
    </div>
  );
}

const HEX_RE = /^#?([0-9a-f]{6})$/i;

/** A hex field that takes a colour once it is one, and shows the colour it holds otherwise. */
function HexField({ value, onChange, label }: { value: string; onChange: (hex: string) => void; label: string }) {
  const [draft, setDraft] = useState(value.toUpperCase());
  useEffect(() => setDraft(value.toUpperCase()), [value]);
  return (
    <Input
      className={s.hex} value={draft} aria-label={label} spellCheck={false} autoComplete="off" maxLength={7}
      onChange={(e) => {
        setDraft(e.target.value);
        const m = HEX_RE.exec(e.target.value.trim());
        if (m) onChange(`#${m[1]!.toLowerCase()}`);
      }}
      onBlur={() => setDraft(value.toUpperCase())}
    />
  );
}

export interface CustomEditorProps {
  spec: ThemeSpec;
  dark: boolean;
  onChange: (spec: ThemeSpec) => void;
  /** a screen of its own (a phone) */
  phone?: boolean;
}

/** The second accent when it is first switched on: the seed's opposite hue. */
const opposite = (seed: string) => seedFromHue((hctOf(seed).hue + 180) % 360, 56, 60);

/** Custom: a colour (native picker and hex), its hue, a second accent for the player, the lowest text contrast. */
export function CustomEditor({ spec, dark, onChange, phone = false }: CustomEditorProps) {
  const hue = Math.round(hctOf(spec.seed).hue) % 360;
  const contrast = useMemo(() => minRatios(spec, dark).text, [spec, dark]);
  const track = useMemo(() => ({ ['--track' as string]: hueTrack() }) as CSSProperties, []);
  return (
    <div className={`${s.editor} ${phone ? s.editorPhone : ''}`}>
      <MiniTheme id="custom" spec={spec} dark={dark} large />
      <div className={s.fields}>
        <div className={s.field}>
          <span className={s.fieldLabel} id="theme-colour">Colour</span>
          <span className={s.colourRow}>
            <input type="color" className={s.native} value={spec.seed} aria-labelledby="theme-colour" onChange={(e) => onChange({ ...spec, seed: e.target.value })} />
            <HexField value={spec.seed} label="Colour hex" onChange={(seed) => onChange({ ...spec, seed })} />
          </span>
        </div>
        <label className={s.field}>
          <span className={s.fieldLabel}>Hue</span>
          <input
            type="range" min={0} max={359} step={1} value={hue} className={s.hue} style={track} aria-valuetext={`${hue}°`}
            onChange={(e) => onChange({ ...spec, seed: withHue(spec.seed, Number(e.target.value)) })}
          />
        </label>
        <div className={s.field}>
          <span className={s.fieldLabel} id="theme-accent2">Second accent</span>
          <span className={s.colourRow}>
            <SegmentedControl
              size="sm" label="Second accent" value={spec.accent2 ? 'on' : 'off'}
              options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
              onChange={(v) => onChange({ ...spec, accent2: v === 'on' ? opposite(spec.seed) : null })}
            />
            {spec.accent2 && (
              <>
                <input type="color" className={s.native} value={spec.accent2} aria-label="Second accent colour" onChange={(e) => onChange({ ...spec, accent2: e.target.value })} />
                <HexField value={spec.accent2} label="Second accent hex" onChange={(accent2) => onChange({ ...spec, accent2 })} />
              </>
            )}
          </span>
        </div>
        <div className={s.contrast}>
          <span className={s.fieldLabel}>Contrast</span>
          <span className={s.value}>{contrast.toFixed(1)} : 1</span>
        </div>
      </div>
    </div>
  );
}
