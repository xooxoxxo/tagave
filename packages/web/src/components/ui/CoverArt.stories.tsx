import type { Meta, StoryObj } from '@storybook/react-vite';
import { CoverArt, CoverChip } from './CoverArt';
import { COVER_SRC, Row } from '../../stories/fixtures';

const meta = {
  title: 'Components/CoverArt',
  component: CoverArt,
  parameters: { docs: { description: { component: 'A square album cover. Without art it draws the placeholder: a field tinted with the album\'s own hue, a groove mark and the initials in the display face, the same for the same title every time. The parent sets the size (or use `fill`). Overlays go in as children (CoverChip): state in words, colour only as a dot.' } } },
  args: { title: 'Café del Mar, Vol. 7', src: null },
  render: (args) => <div style={{ width: 200 }}><CoverArt {...args} /></div>,
} satisfies Meta<typeof CoverArt>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Placeholder: Story = {};
export const WithImage: Story = { args: { src: COVER_SRC, alt: 'Cover of Café del Mar, Vol. 7' } };

export const PlaceholderHues: Story = {
  render: () => <Row>{['The Köln Concert', 'Selected Ambient Works 85–92', 'Kind of Blue', 'Untitled', 'ÿ'].map((t) => <div key={t} style={{ width: 140 }}><CoverArt title={t} /></div>)}</Row>,
};

export const Dimmed: Story = {
  render: () => <Row>
    <div style={{ width: 160 }}><CoverArt title="Missing album" dimmed="missing" /></div>
    <div style={{ width: 160 }}><CoverArt title="Skipped album" src={COVER_SRC} dimmed="ignored" /></div>
  </Row>,
};

export const Compact: Story = {
  render: () => <Row>{['Kind of Blue', 'Blue Train'].map((t) => <div key={t} style={{ width: 40 }}><CoverArt title={t} compact /></div>)}</Row>,
};

export const WithChips: Story = {
  render: () => <Row>
    <div style={{ width: 200 }}><CoverArt title="Kind of Blue" src={COVER_SRC}><CoverChip>Vinyl</CoverChip></CoverArt></div>
    <div style={{ width: 200 }}><CoverArt title="Blue Train"><CoverChip tone="accent" corner="top-left">New</CoverChip></CoverArt></div>
    <div style={{ width: 200 }}><CoverArt title="Giant Steps"><CoverChip tone="warn">4 artist tags</CoverChip></CoverArt></div>
  </Row>,
};

export const InteractiveHover: Story = {
  parameters: { pseudo: { hover: ['div'] } },
  render: () => <div style={{ width: 200 }}><CoverArt title="Kind of Blue" src={COVER_SRC} interactive /></div>,
};
