import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const css = readFileSync(new URL('../../styles/tokens.css', import.meta.url), 'utf8');
function luminance(token: string) {
  const hex = css.match(new RegExp(`--${token}: (#[0-9a-f]{6});`))?.[1];
  if (!hex) throw new Error(`Missing color token: ${token}`);
  const linear = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722;
}
describe('design-system text contrast', () => {
  it.each([['text-primary', 'bg-primary'], ['text-secondary', 'bg-tertiary'], ['text-tertiary', 'bg-secondary'], ['text-selected', 'surface-selected'], ['success', 'surface-success'], ['warning', 'surface-warning'], ['error', 'surface-danger'], ['info', 'surface-info'], ['accent', 'surface-accent']])('%s on %s meets AA text contrast', (ink, surface) => {
    const a = luminance(ink), b = luminance(surface);
    expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toBeGreaterThanOrEqual(4.5);
  });
});
