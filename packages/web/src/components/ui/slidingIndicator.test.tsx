import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Tabs } from './Tabs';
import { SegmentedControl } from './SegmentedControl';
import { INDICATOR_EASE, INDICATOR_MS, indicatorFrames, indicatorParts, midWidth, shouldAnimate, translationOf } from './useSlidingIndicator';

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const rule = (css: string, selector: string) =>
  [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((m) => m[1] ?? '').join('\n');

/** Parse "translate(Apx, Bpx) scaleX(S)" into numbers. */
function parse(t: string) {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)(?: scaleX\(([-\d.]+)\))?/.exec(t);
  if (!m) throw new Error(`not a part transform: ${t}`);
  return { x: Number(m[1]), y: Number(m[2]), s: m[3] === undefined ? 1 : Number(m[3]) };
}

describe('sliding pill: flows like a raindrop, transforms only', () => {
  it('~300ms on a soft spring curve that settles with a slight overshoot', () => {
    expect(INDICATOR_MS).toBe(300);
    expect(INDICATOR_EASE).toBe('cubic-bezier(0.2, 0.9, 0.25, 1.15)');
    // the CSS tokens (label crossfade) keep the same numbers
    const tokens = read('../../styles/tokens.css');
    expect(tokens).toMatch(/--dur-indicator: 300ms;/);
    expect(tokens).toMatch(/--ease-drop: cubic-bezier\(0\.2, 0\.9, 0\.25, 1\.15\);/);
  });

  it('at rest the parts tile the pill exactly: caps at both ends, the band between their centres', () => {
    const box = { x: 120, y: 4, width: 100, height: 40 };
    const parts = indicatorParts(box, midWidth(box));
    const left = parse(parts.left);
    const mid = parse(parts.mid);
    const right = parse(parts.right);
    expect(left).toEqual({ x: 120, y: 4, s: 1 });
    expect(right).toEqual({ x: 120 + 100 - 40, y: 4, s: 1 }); // right cap's box starts one diameter before the end
    expect(mid).toEqual({ x: 140, y: 4, s: 1 }); // from the left cap's centre...
    expect(midWidth(box)).toBe(60); // ...to the right cap's centre
  });

  it('a slide is a FLIP: from the old pill to the new, the band scaled against the new width', () => {
    const from = { x: 4, y: 4, width: 80, height: 40 };
    const to = { x: 90, y: 4, width: 120, height: 40 };
    const f = indicatorFrames(from, to);
    expect(f.midBase).toBe(80);
    expect(parse(f.left[0]).x).toBe(4);
    expect(parse(f.left[1]).x).toBe(90);
    expect(parse(f.right[0]).x).toBe(4 + 80 - 40);
    expect(parse(f.right[1]).x).toBe(90 + 120 - 40);
    expect(parse(f.mid[0]).s).toBe(0.5); // old band 40px over a laid-out 80px
    expect(parse(f.mid[1]).s).toBe(1);
    // every keyframe is a transform: nothing that needs layout or paint per frame
    for (const t of [...f.left, ...f.mid, ...f.right]) expect(t).not.toMatch(/width|left|top|height/);
  });

  it('mid-flight the shape stays a pill: caps never scale, any blend of the frames keeps the band between them', () => {
    const from = { x: 4, y: 4, width: 70, height: 40 };
    const to = { x: 200, y: 4, width: 130, height: 40 };
    const f = indicatorFrames(from, to);
    for (const p of [0, 0.25, 0.5, 1, 1.04]) { // 1.04: the overshoot
      const lerp = (a: number, b: number) => a + (b - a) * p;
      const l = lerp(parse(f.left[0]).x, parse(f.left[1]).x);
      const r = lerp(parse(f.right[0]).x, parse(f.right[1]).x);
      const mx = lerp(parse(f.mid[0]).x, parse(f.mid[1]).x);
      const ms = lerp(parse(f.mid[0]).s, parse(f.mid[1]).s);
      expect(mx).toBeCloseTo(l + 20, 2); // band starts at the left cap's centre
      expect(mx + ms * f.midBase).toBeCloseTo(r + 20, 2); // and ends at the right cap's centre
    }
    expect(f.left.join()).not.toMatch(/scale/);
    expect(f.right.join()).not.toMatch(/scale/);
  });

  it('only a change of selection animates; never the first placement; never with reduced motion', () => {
    expect(shouldAnimate(true, true, false)).toBe(true);
    expect(shouldAnimate(false, true, false)).toBe(false); // a resize or font load: instant
    expect(shouldAnimate(true, false, false)).toBe(false); // first placement: instant
    expect(shouldAnimate(true, true, true)).toBe(false); // reduced motion: instant
  });

  it('reads where a moving pill is from its computed transform (to retarget mid-flight)', () => {
    expect(translationOf('matrix(1, 0, 0, 1, 42.5, 4)')).toEqual({ x: 42.5, y: 4 });
    expect(translationOf('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 12, 3, 0, 1)')).toEqual({ x: 12, y: 3 });
    expect(translationOf('none')).toBeNull();
  });

  it('the hook animates parts with Web Animations and honours reduced motion', () => {
    const src = readFileSync(new URL('./useSlidingIndicator.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/\.animate\(/);
    expect(src).toMatch(/prefers-reduced-motion: reduce/);
    expect(src).toMatch(/!prefersReducedMotion\(\)/);
    // no width/height transition anywhere: those lay out on every frame
    expect(src).not.toMatch(/transition/);
  });
});

describe('sliding pill: one look in every tab strip and segmented control', () => {
  it('both primitives render the same three-part pill', () => {
    const tabs = renderToStaticMarkup(<Tabs items={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} value="b" />);
    const seg = renderToStaticMarkup(<SegmentedControl label="View" name="v" value="list" onChange={() => undefined} options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]} />);
    for (const html of [tabs, seg]) {
      expect(html).toMatch(/aria-hidden="true"><span[^>]*data-part="left"><\/span><span[^>]*data-part="right"><\/span><span[^>]*data-part="mid"><\/span><\/span>/);
    }
  });

  it('server markup: the active item paints its own bubble until the pill is placed', () => {
    const tabs = renderToStaticMarkup(<Tabs items={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} value="b" />);
    expect(tabs).toMatch(/aria-selected="true" data-active="true"/);
    expect(tabs).not.toMatch(/data-indicator/);
    const seg = renderToStaticMarkup(<SegmentedControl label="View" name="v" value="list" onChange={() => undefined} options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]} />);
    expect(seg).toMatch(/data-active="true"[^>]*><input[^>]*value="list"/);
    expect(rule(read('./Tabs.module.css'), '.tablist[data-indicator] .active,\n.tablist[data-indicator] .active:hover')).toMatch(/background: transparent/);
    expect(rule(read('./SegmentedControl.module.css'), '.track[data-indicator] .selected,\n.track[data-indicator] .selected:hover')).toMatch(/background: transparent/);
  });

  it('caps are round and only translate; will-change only while moving; hidden in forced colours', () => {
    const css = read('./SlidingPill.module.css');
    expect(rule(css, '.cap')).toMatch(/border-radius: 50%/);
    expect(rule(css, '.pill[data-moving] > *')).toMatch(/will-change: transform/);
    expect(rule(css, '.pill')).not.toMatch(/will-change/);
    expect(css).toMatch(/forced-colors: active\)\s*\{\s*\.pill\s*\{\s*display: none/);
  });

  it('labels crossfade over the slide instead of flipping colour', () => {
    expect(rule(read('./Tabs.module.css'), '.tab')).toMatch(/transition: color var\(--dur-indicator\) var\(--ease-out\)/);
    expect(rule(read('./SegmentedControl.module.css'), '.option')).toMatch(/transition: color var\(--dur-indicator\) var\(--ease-out\)/);
  });

  it('reduced motion: the label colours change at once too', () => {
    expect(read('./Tabs.module.css')).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.tab\s*\{\s*transition: none/);
    expect(read('./SegmentedControl.module.css')).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.option\s*\{\s*transition: none/);
  });
});
