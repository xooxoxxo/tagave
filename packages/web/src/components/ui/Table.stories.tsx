import type { Meta, StoryObj } from '@storybook/react-vite';
import { Table, TableRow, Td, Th } from './Table';
import { Badge } from './Badge';
import { Card } from './Card';
import { EmptyState } from './EmptyState';

const meta = {
  title: 'Components/Table',
  component: Table,
  parameters: { docs: { description: { component: 'Tabular data: Table with Th and Td; it scrolls sideways inside its wrapper on a narrow screen. TableRow makes the whole row the link (click, Enter or Space) without nesting a table in a link. For a list of albums or artists, use the grid or list views instead.' } } },
} satisfies Meta<typeof Table>;
export default meta;
type Story = StoryObj<typeof meta>;

const rows = [
  ['Café del Mar, Vol. 7', 'Various Artists', <Badge key="m" tone="success">Matched</Badge>],
  ['Unidentified album', 'Unknown artist', <Badge key="r" tone="warning">Needs review</Badge>],
  ['Kind of Blue', 'Miles Davis', <Badge key="f" tone="danger">Failed</Badge>],
] as const;

export const Basic: Story = {
  render: () => <Card padded={false}><Table><thead><tr><Th>Album</Th><Th>Artist</Th><Th>Status</Th></tr></thead><tbody>{rows.map(([a, b, c]) => <tr key={a}><Td>{a}</Td><Td>{b}</Td><Td>{c}</Td></tr>)}</tbody></Table></Card>,
};

export const ClickableRows: Story = {
  render: () => <Card padded={false}><Table><thead><tr><Th>Album</Th><Th>Artist</Th><Th>Status</Th></tr></thead><tbody>{rows.map(([a, b, c]) => <TableRow key={a} to="/"><Td>{a}</Td><Td>{b}</Td><Td>{c}</Td></TableRow>)}</tbody></Table></Card>,
};

export const RowHover: Story = {
  parameters: { pseudo: { hover: ['tbody tr:first-child'] } },
  render: ClickableRows.render!,
};

export const Empty: Story = {
  render: () => <Card padded={false}><Table><thead><tr><Th>Album</Th><Th>Artist</Th><Th>Status</Th></tr></thead><tbody><tr><Td colSpan={3}><EmptyState title="No plans yet" text="Plans appear here once you preview a tag change." /></Td></tr></tbody></Table></Card>,
};

export const LongText: Story = {
  render: () => <div style={{ width: 360 }}><Card padded={false}><Table><thead><tr><Th>Path</Th><Th>Size</Th></tr></thead><tbody><tr><Td><code>/music/Various Artists/Café del Mar, Volumen Siete (Remastered Deluxe Edition)/01 - Intro.flac</code></Td><Td>38 MB</Td></tr></tbody></Table></Card></div>,
};
