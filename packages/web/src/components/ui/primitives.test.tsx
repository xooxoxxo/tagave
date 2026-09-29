import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, IconButton, buttonClassName } from './Button';
import { Chip } from './Chip';
import { SearchField, TextField } from './FormControl';
import { Tooltip } from './Tooltip';
import { SegmentedControl } from './SegmentedControl';
import { Surface } from './Card';
import { applyTheme, isThemePreference, readThemePreference, setThemePreference, THEME_STORAGE_KEY } from '../../theme';

describe('Button family', () => {
  it('layers the label in its own span above the sheen', () => {
    const html = renderToStaticMarkup(<Button>Apply plan</Button>);
    expect(html).toMatch(/<button[^>]*><span class="[^"]*label[^"]*">Apply plan<\/span><\/button>/);
  });

  it('keeps the label (and so the accessible name and width) while loading, and adds a hidden spinner', () => {
    const html = renderToStaticMarkup(<Button loading>Saving changes</Button>);
    expect(html).toContain('Saving changes');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<span class="[^"]*spinner[^"]*" aria-hidden="true">/);
    expect(renderToStaticMarkup(<Button>Save</Button>)).not.toContain('spinner');
  });

  it('keeps the old ghost variant working as quiet', () => {
    expect(buttonClassName({ variant: 'ghost' })).toContain('ghost');
    expect(buttonClassName({ variant: 'quiet' })).toContain('quiet');
    expect(buttonClassName({})).toContain('primary');
    expect(buttonClassName({})).toContain('size-md');
  });

  it('adds the icon shape and size classes', () => {
    const cls = buttonClassName({ variant: 'secondary', size: 'sm', icon: true, className: 'extra' });
    for (const part of ['button', 'secondary', 'size-sm', 'icon', 'extra']) expect(cls).toContain(part);
  });

  it('gives an IconButton an accessible name and a native tooltip, as a clear bubble by default', () => {
    const html = renderToStaticMarkup(<IconButton label="Toggle theme"><svg /></IconButton>);
    expect(html).toContain('aria-label="Toggle theme"');
    expect(html).toContain('title="Toggle theme"');
    expect(html).toMatch(/class="[^"]*secondary[^"]*icon/);
    expect(html).toContain('type="button"');
  });
});

describe('Chip', () => {
  it('is a plain label without onClick', () => {
    const html = renderToStaticMarkup(<Chip>FLAC</Chip>);
    expect(html.startsWith('<span')).toBe(true);
    expect(html).not.toContain('aria-pressed');
  });

  it('is a toggle button with onClick, reporting its state', () => {
    const on = renderToStaticMarkup(<Chip active onClick={() => undefined}>Compilations</Chip>);
    expect(on.startsWith('<button')).toBe(true);
    expect(on).toContain('type="button"');
    expect(on).toContain('aria-pressed="true"');
    expect(renderToStaticMarkup(<Chip onClick={() => undefined}>Lossless</Chip>)).toContain('aria-pressed="false"');
  });

  it('draws a decorative status dot', () => {
    expect(renderToStaticMarkup(<Chip dot="warn">Needs review</Chip>)).toMatch(/<span class="[^"]*dot-warn[^"]*" aria-hidden="true">/);
  });
});

describe('fields', () => {
  it('names a search field without a visible label and marks the / hint decorative', () => {
    const html = renderToStaticMarkup(<SearchField label="Search the library" />);
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Search the library"');
    expect(html).toMatch(/<kbd[^>]*aria-hidden="true"[^>]*>\/<\/kbd>/);
    expect(renderToStaticMarkup(<SearchField label="Filter" slashShortcut={false} />)).not.toContain('<kbd');
  });

  it('shows a pending change struck through and links it to the input', () => {
    const html = renderToStaticMarkup(<TextField id="aa" label="Album artist" value="Various Artists" readOnly previousValue="DJ Example" />);
    expect(html).toContain('<s>DJ Example</s>');
    expect(html).toContain('aria-describedby="aa-previous"');
    expect(html).toContain('id="aa-previous"');
  });

  it('says (empty) rather than showing nothing for a blank previous value', () => {
    expect(renderToStaticMarkup(<TextField id="g" label="Genre" previousValue="" />)).toContain('<s>(empty)</s>');
  });
});

describe('Tooltip', () => {
  it('describes its trigger and starts hidden', () => {
    const html = renderToStaticMarkup(<Tooltip content="Reverts every file"><button type="button" aria-describedby="help">Revert</button></Tooltip>);
    const id = html.match(/role="tooltip" id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`aria-describedby="help ${id}"`);
    expect(html).not.toMatch(/class="[^"]*\bopen\b/);
  });
});

describe('SegmentedControl', () => {
  it('renders one native radio per option in a named group', () => {
    const html = renderToStaticMarkup(<SegmentedControl label="Colour theme" name="t" value="dark" onChange={() => undefined} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Colour theme"');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/<input[^>]*value="dark"[^>]*>/)?.[0]).toContain('checked=""');
    expect(html.match(/<input[^>]*value="light"[^>]*>/)?.[0]).not.toContain('checked');
  });
});

describe('Surface', () => {
  it('applies the variant class', () => {
    expect(renderToStaticMarkup(<Surface variant="glass">x</Surface>)).toMatch(/class="[^"]*surface-glass/);
  });
});

describe('theme preference', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const fakeRoot = () => {
    const attrs = new Map<string, string>();
    return {
      attrs,
      el: { setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) } as unknown as HTMLElement,
    };
  };

  it('pins light or dark with data-theme and removes it to follow the OS', () => {
    const root = fakeRoot();
    applyTheme('dark', root.el);
    expect(root.attrs.get('data-theme')).toBe('dark');
    applyTheme('light', root.el);
    expect(root.attrs.get('data-theme')).toBe('light');
    applyTheme('system', root.el);
    expect(root.attrs.has('data-theme')).toBe(false);
  });

  it('defaults to system, ignores junk, and survives blocked storage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    expect(readThemePreference()).toBe('system');
    store.set(THEME_STORAGE_KEY, 'neon');
    expect(readThemePreference()).toBe('system');
    store.set(THEME_STORAGE_KEY, 'dark');
    expect(readThemePreference()).toBe('dark');
    setThemePreference('system');
    expect(store.has(THEME_STORAGE_KEY)).toBe(false);
    setThemePreference('light');
    expect(store.get(THEME_STORAGE_KEY)).toBe('light');

    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } });
    expect(readThemePreference()).toBe('system');
    expect(() => setThemePreference('dark')).not.toThrow();
  });

  it('recognises only the three preferences', () => {
    expect(['system', 'light', 'dark'].every(isThemePreference)).toBe(true);
    expect(isThemePreference('auto')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
});
