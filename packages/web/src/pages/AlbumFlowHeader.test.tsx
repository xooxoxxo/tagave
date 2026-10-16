import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AlbumFlowHeader, maintenanceKeyLabel, type AlbumFlowHeaderProps } from './AlbumFlowHeader';

const props = (over: Partial<AlbumFlowHeaderProps> = {}): AlbumFlowHeaderProps => ({
  docked: false,
  artist: 'Porcupine Tree',
  title: 'In Absentia',
  glide: { x: 0, y: 51 },
  backLabel: 'Back to Albums',
  onBack: vi.fn(),
  onTop: vi.fn(),
  end: <button type="button" aria-label="More for this album" />,
  ...over,
});

/** The rendered buttons; function components without hooks (the icon buttons) are expanded. */
function buttons(p: AlbumFlowHeaderProps): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isValidElement(node)) return;
    const el = node as ReactElement<Record<string, unknown>>;
    if (typeof el.type === 'function') { walk((el.type as (q: unknown) => ReactNode)(el.props)); return; }
    if (el.type === 'button') out.push(el);
    walk(el.props.children as ReactNode);
  };
  walk(AlbumFlowHeader(p));
  return out;
}

describe('album header', () => {
  it('three buttons in order: back | title | ⋮', () => {
    const [back, mid, more] = buttons(props());
    expect(back?.props['aria-label']).toBe('Back to Albums');
    expect(mid?.props['aria-label']).toBe('Back to the top of the album');
    expect(more?.props['aria-label']).toBe('More for this album');
  });

  it('back navigates back, the title goes to the top', () => {
    const p = props();
    const [back, mid] = buttons(p);
    (back!.props.onClick as () => void)();
    expect(p.onBack).toHaveBeenCalledTimes(1);
    (mid!.props.onClick as () => void)();
    expect(p.onTop).toHaveBeenCalledTimes(1);
  });

  it('never a Play: Play does not dock into the header', () => {
    const html = renderToStaticMarkup(<AlbumFlowHeader {...props({ docked: true })} />);
    expect(html).not.toMatch(/aria-label="(Play|Pause|Resume)"/);
    expect(html).not.toContain('data-header-play');
  });

  it('the back icon is an embossed header icon: no circle, no key', () => {
    const html = renderToStaticMarkup(<AlbumFlowHeader {...props()} />);
    expect(html).toMatch(/<button[^>]*class="[^"]*emboss[^"]*header/);
  });

  it('the title is reachable only when docked', () => {
    expect(buttons(props())[1]!.props.tabIndex).toBe(-1);
    expect(buttons(props({ docked: true }))[1]!.props.tabIndex).toBe(0);
    expect(renderToStaticMarkup(<AlbumFlowHeader {...props({ docked: true })} />)).toContain('data-docked=""');
  });

  it('the album title over the artist; the artist page puts its kind line first', () => {
    const album = renderToStaticMarkup(<AlbumFlowHeader {...props()} />);
    expect(album.indexOf('In Absentia')).toBeLessThan(album.indexOf('Porcupine Tree'));
    const artist = renderToStaticMarkup(<AlbumFlowHeader {...props({ artist: 'Band', title: 'Porcupine Tree', titleFirst: false })} />);
    expect(artist.indexOf('Band')).toBeLessThan(artist.indexOf('Porcupine Tree'));
  });

  it('no way back, no back icon; the others stay', () => {
    const b = buttons(props({ backLabel: null }));
    expect(b).toHaveLength(2);
    expect(b[0]!.props['aria-label']).toBe('Back to the top of the album');
  });

  it('without ⋮ (the artist page): a Maintenance switch for library care, nothing for a listener', () => {
    const toggle = vi.fn();
    const withCare = buttons(props({ end: undefined, maintenance: true, onToggleMaintenance: toggle }));
    const maint = withCare[2]!;
    expect(maint.props['aria-label']).toBe('Turn off Maintenance');
    expect(maint.props['aria-pressed']).toBe(true);
    (maint.props.onClick as () => void)();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(maintenanceKeyLabel(false)).toBe('Turn on Maintenance');
    expect(buttons(props({ end: undefined }))).toHaveLength(2);
  });

  it('the title glides in from where the lines met the header', () => {
    const html = renderToStaticMarkup(<AlbumFlowHeader {...props({ glide: { x: 0, y: 47 } })} />);
    expect(html).toContain('--glide-x:0px');
    expect(html).toContain('--glide-y:47px');
  });
});

describe('album header look', () => {
  const css = readFileSync(new URL('./AlbumFlowHeader.module.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string) =>
    [...css.matchAll(new RegExp(`(?:^|\\n|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1] ?? '').join('\n');

  it('the icons never move: 44px buttons centred 36px in and 32px down, at rest and docked', () => {
    expect(rule('.slot')).toMatch(/top: 10px/);
    expect(rule('.start')).toMatch(/left: 14px/);
    expect(rule('.end')).toMatch(/right: 14px/);
    expect(css).not.toMatch(/\.docked \.slot|\.docked \.start|\.docked \.end/);
  });

  it('no key boxes: no gradients, no cavity', () => {
    expect(css).not.toMatch(/gradient\(/);
    expect(css).not.toMatch(/--key-/);
  });

  it('on a phone the title is centred, so the names glide straight down', () => {
    expect(css).toMatch(/@media \(max-width: 720px\)\s*\{\s*\.mid \{ text-align: center; \}/);
  });

  it('reduced motion: instant states', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.band, \.mid, \.title \{ transition: none !important; \}/);
  });
});
