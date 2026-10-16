import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, IconButton } from '../components/ui/Button';
import { UndoIcon } from '../components/ui/icons';
import { AlbumFlowHeader } from '../pages/AlbumFlowHeader';
import { INDICATOR_EASE, INDICATOR_MS, INDICATOR_SETTLE_EASE } from '../components/ui/useSlidingIndicator';
import { currentTokens, isColour, legacyTokens, resolved, type Token } from './tokens';
import { EditIcon, PlayIcon, Row } from './fixtures';
import styles from './Foundations.module.css';

// The token pages are read from tokens.css at runtime; they get an axe scan but
// no screenshot baseline (the component shots already cover every token).
const meta = {
  title: 'Foundations',
  parameters: { layout: 'padded', docs: { description: { component: 'The tokens in src/styles/tokens.css, read from the loaded stylesheet (nothing is copied into these pages). Switch the theme in the toolbar to see the dark values. Rules for using them are in DESIGN.md.' } } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Re-reads tokens after the theme toolbar changes data-theme. */
function useTokens(pick: (all: Token[]) => Token[]): Token[] {
  const [list, setList] = useState<Token[]>([]);
  useEffect(() => {
    const read = () => setList(pick(currentTokens()));
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [pick]);
  return list;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.group}><h3>{title}</h3>{children}</section>;
}

const colourGroups: [string, RegExp][] = [
  ['Surfaces', /^--(canvas|surface|mist|mist-2|line|line-strong)$/],
  ['Ink', /^--ink/],
  ['Dew accent', /^--(dew|chip-on-ink)/],
  ['Danger', /^--danger/],
  ['Status', /^--(ok|warn)/],
  ['Glass, gloss and focus', /^--(rim|glass|spec|highlight|scrim|ring|clear-hi)/],
  ['Transport keys', /^--key/],
];
const pickColours = (all: Token[]) => all.filter((t) => isColour(t.declared));

function Colours() {
  const tokens = useTokens(pickColours);
  return <div className={styles.page}>
    <p className={styles.lede}>Palette tokens (layer 1). Components use these; the legacy names (--bg-primary, --accent, …) resolve to them.</p>
    {colourGroups.map(([title, re]) => {
      const list = tokens.filter((t) => re.test(t.name));
      if (!list.length) return null;
      return <Group key={title} title={title}>
        <div className={styles.swatches}>{list.map((t) => <div key={t.name} className={styles.swatch}>
          <span className={styles.chip} style={{ background: `var(${t.name})` }} />
          <span className={styles.name}>{t.name}</span>
          <span className={styles.value}>{resolved(t.name)}</span>
        </div>)}</div>
      </Group>;
    })}
  </div>;
}

export const Colour: Story = { name: 'Colour', tags: ['no-shot'], render: () => <Colours /> };

const pickType = (all: Token[]) => all.filter((t) => t.name.startsWith('--type-'));
const SAMPLE: Record<string, string> = {
  '--type-display': 'Quietly in order',
  '--type-headline': 'Compilations, gathered',
  '--type-title': 'Various Artists — Café del Mar',
  '--type-body-lg': 'Twelve tracks share one folder but carry four album-artist tags.',
  '--type-body': 'Set them together, preview the plan, then apply. Every write is journalled.',
  '--type-ui': 'Apply plan · Preview · Settings',
  '--type-label': 'Album artist',
  '--type-mono': 'ALBUMARTIST=Various Artists',
};

function TypeScale() {
  const tokens = useTokens(pickType);
  return <div className={styles.page}>
    <p className={styles.lede}>Urbanist (display, weights 200–400), Figtree (body and controls, 400–700) and JetBrains Mono (paths, tag keys, diffs), self-hosted through @fontsource.</p>
    <div className={styles.rows}>{tokens.map((t) => <div key={t.name} className={styles.row}>
      <div><div className={styles.name}>{t.name}</div><div className={styles.value}>{t.declared}</div></div>
      <div style={{ font: `var(${t.name})`, ...(t.name === '--type-label' ? { textTransform: 'uppercase', letterSpacing: '.14em' } : {}) }}>{SAMPLE[t.name] ?? 'Sample'}</div>
    </div>)}</div>
  </div>;
}

export const Type: Story = { tags: ['no-shot'], render: () => <TypeScale /> };

const pickSpace = (all: Token[]) => all.filter((t) => /^--(space|r-|h-)/.test(t.name));

function SpaceRadii() {
  const tokens = useTokens(pickSpace);
  const space = tokens.filter((t) => t.name.startsWith('--space'));
  const radii = tokens.filter((t) => t.name.startsWith('--r-'));
  const heights = tokens.filter((t) => t.name.startsWith('--h-'));
  return <div className={styles.page}>
    <Group title="Space">
      <div className={styles.rows}>{space.map((t) => <div key={t.name} className={styles.row}>
        <div><div className={styles.name}>{t.name}</div><div className={styles.value}>{t.declared}</div></div>
        <div className={styles.bar} style={{ width: `var(${t.name})` }} />
      </div>)}</div>
    </Group>
    <Group title="Radii">
      <Row gap={24}>{radii.map((t) => <div key={t.name} className={styles.swatch}>
        <div className={styles.radius} style={{ borderRadius: `var(${t.name})` }} />
        <span className={styles.name}>{t.name}</span><span className={styles.value}>{t.declared}</span>
      </div>)}</Row>
    </Group>
    <Group title="Control heights">
      <Row gap={24}>{heights.map((t) => <div key={t.name} className={styles.swatch}>
        <div className={styles.radius} style={{ height: `var(${t.name})`, borderRadius: 'var(--r-pill)', width: 120 }} />
        <span className={styles.name}>{t.name}</span><span className={styles.value}>{t.declared}</span>
      </div>)}</Row>
    </Group>
  </div>;
}

export const SpaceAndRadii: Story = { name: 'Space and radii', tags: ['no-shot'], render: () => <SpaceRadii /> };

const pickShadow = (all: Token[]) => all.filter((t) => /^--(shadow-card|shadow-float|clear-shadow)$/.test(t.name));

function Elevation() {
  const tokens = useTokens(pickShadow);
  return <div className={styles.page}>
    <p className={styles.lede}>Surfaces are flat; elevation is for cards (a soft drop), floating layers (menus, toasts, sheets) and the clear bubble of secondary controls.</p>
    <div className={styles.elevation}>{tokens.map((t) => <div key={t.name} className={styles.swatch}>
      <div className={styles.lift} style={{ boxShadow: `var(${t.name})` }}>{t.name}</div>
    </div>)}</div>
  </div>;
}

export const ElevationStory: Story = { name: 'Elevation', tags: ['no-shot'], render: () => <Elevation /> };

const pickMotion = (all: Token[]) => all.filter((t) => /^--(dur|ease)/.test(t.name));

function bezierPath(ease: string): string | null {
  const m = /cubic-bezier\(([^)]+)\)/.exec(ease);
  if (!m) return null;
  const [x1, y1, x2, y2] = m[1]!.split(',').map(Number) as [number, number, number, number];
  const X = (x: number) => x * 160;
  const Y = (y: number) => 100 - y * 100;
  return `M0 100 C ${X(x1)} ${Y(y1)}, ${X(x2)} ${Y(y2)}, 160 0`;
}

function Motion() {
  const tokens = useTokens(pickMotion);
  const eases = [...tokens.filter((t) => t.name.startsWith('--ease')).map((t) => ({ name: t.name, value: t.declared })), { name: 'INDICATOR_EASE (sliding pill, run)', value: INDICATOR_EASE }, { name: 'INDICATOR_SETTLE_EASE (settle)', value: INDICATOR_SETTLE_EASE }];
  return <div className={styles.page}>
    <p className={styles.lede}>Motion is short and transform-only where it moves things. Every animation has a prefers-reduced-motion path that is instant. The sliding pill runs {INDICATOR_MS}ms (--dur-indicator).</p>
    <Group title="Durations">
      <div className={styles.rows}>{tokens.filter((t) => t.name.startsWith('--dur')).map((t) => <div key={t.name} className={styles.row}>
        <div><div className={styles.name}>{t.name}</div><div className={styles.value}>{t.declared}</div></div>
        <div className={styles.bar} style={{ width: `calc(${parseFloat(t.declared) || 0}px)` }} />
      </div>)}</div>
    </Group>
    <Group title="Easing">
      <div className={styles.cols}>{eases.map((e) => {
        const d = bezierPath(e.value);
        return <div key={e.name} className={styles.swatch}>
          <svg className={styles.curve} viewBox="0 0 160 100" aria-hidden="true"><line x1="0" y1="100" x2="160" y2="100" /><line x1="0" y1="0" x2="0" y2="100" />{d && <path d={d} />}</svg>
          <span className={styles.name}>{e.name}</span><span className={styles.value}>{e.value}</span>
        </div>;
      })}</div>
    </Group>
  </div>;
}

export const MotionStory: Story = { name: 'Motion', tags: ['no-shot'], render: () => <Motion /> };

function Keys() {
  return <div className={styles.page}>
    <p className={styles.lede}>Two pressable systems. The drop (Button, IconButton, LinkButton): a glossy primary drop, a clear secondary bubble, quiet text buttons, and danger. The embossed icon (EmbossIconButton): the glyph alone, raised by a fine highlight and shade (--emboss-* tokens), a thin niche outline on hover on the page, none in a header; the album header (AlbumFlowHeader) uses it.</p>
    <Group title="Drops">
      <Row><Button>Apply plan</Button><Button variant="secondary">Preview</Button><Button variant="secondary"><UndoIcon />Revert</Button><Button variant="quiet">Cancel</Button><Button variant="quiet-danger">Delete</Button><Button variant="danger">Delete (dialog)</Button></Row>
      <Row><IconButton label="Play" variant="primary"><PlayIcon /></IconButton><IconButton label="Edit tags"><EditIcon /></IconButton><IconButton label="Revert" variant="quiet"><UndoIcon /></IconButton><Button size="sm">Small</Button><Button size="sm" variant="secondary">Small</Button></Row>
    </Group>
    <Group title="Album header: at rest">
      <div className={styles.keys}><AlbumFlowHeader docked={false} artist="Miles Davis" title="Kind of Blue" glide={{ x: 0, y: 0 }} backLabel="Back to albums" onBack={() => undefined} onTop={() => undefined} maintenance={false} onToggleMaintenance={() => undefined} /></div>
    </Group>
    <Group title="Album header: docked (artist page, Maintenance on)">
      <div className={styles.keys}><AlbumFlowHeader docked artist="Miles Davis" title="Kind of Blue" glide={{ x: 0, y: 0 }} backLabel="Back to albums" onBack={() => undefined} onTop={() => undefined} maintenance onToggleMaintenance={() => undefined} /></div>
    </Group>
  </div>;
}

export const ButtonsAndKeys: Story = { name: 'Buttons and keys', render: () => <Keys /> };

function Legacy() {
  const tokens = legacyTokens();
  return <div className={styles.page}>
    <p className={styles.lede}>Layer 3: names older pages were written against. They resolve to the palette and scale above; new code uses the layer 1 and 2 names.</p>
    <div className={styles.rows}>{tokens.map((t) => <div key={t.name} className={styles.row}><span className={styles.name}>{t.name}</span><span className={styles.value}>{t.declared}</span></div>)}</div>
  </div>;
}

export const LegacyNames: Story = { name: 'Legacy names', tags: ['no-shot'], render: () => <Legacy /> };
