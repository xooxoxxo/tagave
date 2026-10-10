import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AlbumFlowHeader, maintenanceKeyLabel, pressHandlers, type AlbumFlowHeaderProps } from './AlbumFlowHeader';

const props = (over: Partial<AlbumFlowHeaderProps> = {}): AlbumFlowHeaderProps => ({
  docked: false,
  artist: 'Porcupine Tree',
  title: 'In Absentia',
  glide: { x: -64, y: 51 },
  backLabel: 'Back to Albums',
  onBack: vi.fn(),
  onTop: vi.fn(),
  maintenance: false,
  onToggleMaintenance: vi.fn(),
  ...over,
});

/** The rendered buttons (the component is a plain tree of elements, no hooks). */
function buttons(p: AlbumFlowHeaderProps): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isValidElement(node)) return;
    const el = node as ReactElement<Record<string, unknown>>;
    if (el.type === 'button') out.push(el);
    walk(el.props.children as ReactNode);
  };
  walk(AlbumFlowHeader(p));
  return out;
}

describe('album header keys', () => {
  it('three buttons in order: back | artist + album | Maintenance', () => {
    const [back, mid, maint] = buttons(props());
    expect(back?.props['aria-label']).toBe('Back to Albums');
    expect(mid?.props['aria-label']).toBe('Back to the top of the album');
    expect(maint?.props['aria-label']).toBe('Turn on Maintenance');
  });

  it('back navigates back, the middle key goes to the top, Maintenance toggles', () => {
    const p = props();
    const [back, mid, maint] = buttons(p);
    (back!.props.onClick as () => void)();
    expect(p.onBack).toHaveBeenCalledTimes(1);
    (mid!.props.onClick as () => void)();
    expect(p.onTop).toHaveBeenCalledTimes(1);
    (maint!.props.onClick as () => void)();
    expect(p.onToggleMaintenance).toHaveBeenCalledTimes(1);
  });

  it('the middle key is reachable only when docked', () => {
    expect(buttons(props())[1]!.props.tabIndex).toBe(-1);
    expect(buttons(props({ docked: true }))[1]!.props.tabIndex).toBe(0);
    const html = renderToStaticMarkup(<AlbumFlowHeader {...props({ docked: true })} />);
    expect(html).toContain('data-docked=""');
  });

  it('Maintenance says whether it is on', () => {
    expect(maintenanceKeyLabel(true)).toBe('Turn off Maintenance');
    const maint = buttons(props({ maintenance: true }))[2]!;
    expect(maint.props['aria-pressed']).toBe(true);
    expect(maint.props['aria-label']).toBe('Turn off Maintenance');
  });

  it('no way back, no back key; the others stay', () => {
    const b = buttons(props({ backLabel: null }));
    expect(b).toHaveLength(2);
    expect(b[0]!.props['aria-label']).toBe('Back to the top of the album');
  });

  it('the title glides in from where the lines met the header', () => {
    const html = renderToStaticMarkup(<AlbumFlowHeader {...props({ glide: { x: -40, y: 47 } })} />);
    expect(html).toContain('--glide-x:-40px');
    expect(html).toContain('--glide-y:47px');
    expect(html).toContain('Porcupine Tree');
    expect(html).toContain('In Absentia');
  });

  it('a press shows on touch too: pointer down adds the pressed look, up, leave and cancel take it off', () => {
    const h = pressHandlers('pressed');
    const classes = new Set<string>();
    const e = { currentTarget: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } } } as never;
    h.onPointerDown(e);
    expect(classes.has('pressed')).toBe(true);
    h.onPointerUp(e);
    expect(classes.has('pressed')).toBe(false);
    h.onPointerDown(e);
    h.onPointerLeave(e);
    expect(classes.has('pressed')).toBe(false);
    h.onPointerDown(e);
    h.onPointerCancel(e);
    expect(classes.has('pressed')).toBe(false);
  });
});

describe('album header look (approved prototype values)', () => {
  const css = readFileSync(new URL('./AlbumFlowHeader.module.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string) =>
    [...css.matchAll(new RegExp(`(?:^|\\n|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1] ?? '').join('\n');

  it('the cavity: one dark colour at 80%, no border', () => {
    expect(rule('.cavity')).toMatch(/background: var\(--key-cavity\)/);
    expect(rule('.cavity')).not.toMatch(/border/);
    const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
    expect(tokens).toMatch(/--key-cavity: rgba\(8, 14, 20, 0\.8\);/);
  });

  it('keys at rest: 44px round, icon centre 36px in and 32px down', () => {
    const key = rule('.key');
    expect(key).toMatch(/top: 10px/);
    expect(key).toMatch(/width: 44px/);
    expect(key).toMatch(/height: 44px/);
    expect(key).toMatch(/border-radius: 22px/);
    expect(rule('.backKey')).toMatch(/left: 14px/);
    expect(rule('.maintKey')).toMatch(/right: 14px/);
  });

  it('docked: 72 × 64 square end keys touching the middle key', () => {
    const docked = rule('.docked .key');
    expect(docked).toMatch(/top: 0/);
    expect(docked).toMatch(/width: 72px/);
    expect(docked).toMatch(/height: 64px/);
    expect(docked).toMatch(/border-radius: 0/);
    expect(rule('.midKey')).toMatch(/left: 72px/);
    expect(rule('.midKey')).toMatch(/right: 72px/);
  });

  it('pressed: hinged at the top edge, the bottom tips in about 6°', () => {
    expect(rule('.key')).toMatch(/transform-origin: 50% 0%/);
    expect(css).toMatch(/transform: perspective\(260px\) rotateX\(-6deg\)/);
  });

  it('reduced motion: instant states', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.key, \.midKey, \.title, \.cavity \{ transition: none !important; \}/);
  });
});
