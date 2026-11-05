import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { MaintenanceInspector, MaintenanceSummary, PickBar, type InspectorSelection, type InspectorStateModel, type InspectorTool, type MaintenanceInspectorProps } from '../pages/MaintenanceInspector';
import { MaintenanceSheet } from '../pages/MaintenanceSheet';
import { attentionItems, type AlbumTab, type AttentionAlbum, type AttentionItem } from '../utils/albumAttention';
import { EMPTY_TICKS, inspectorRows, reconcileTicks, type TickState } from '../utils/maintenanceInspector';

const noop = () => undefined;

/** Funeral, matched, with three issues: two tracks missing, IDs missing on one track, no embedded art. */
const FUNERAL: AttentionAlbum = {
  state: 'matched',
  candidates: [],
  hasRelease: true,
  missingTracks: [{}, {}],
  duplicates: [],
  tracks: [],
  gaps: [
    { id: 'g-missing', kind: 'incomplete_album', state: 'open', details: { have: 8, want: 10 } },
    { id: 'g-ids', kind: 'quality', state: 'open', flag: 'missingMbIds', details: { flags: { missingMbIds: { missing: [9] } } } },
    { id: 'g-art', kind: 'quality', state: 'open', flag: 'noEmbeddedArt', details: { flags: { noEmbeddedArt: true } } },
  ],
};

/** An unidentified compilation filed one folder per track: "Treat as one album". */
const COMPILATION: AttentionAlbum = {
  state: 'unidentified',
  candidates: [],
  hasRelease: false,
  missingTracks: [],
  duplicates: [],
  tracks: [],
  gaps: [],
  mergeCandidates: [{ id: 'b', trackCount: 3 }, { id: 'c', trackCount: 2 }],
};

const MATCHED: InspectorStateModel = {
  state: 'matched',
  label: 'Matched',
  onClearAnyEdition: null,
  discogsOnly: false,
  links: [
    { label: 'MusicBrainz', href: 'https://musicbrainz.org/release/00000000-0000-4000-8000-000000000000' },
    { label: 'Discogs', href: 'https://www.discogs.com/release/1' },
  ],
};
const UNIDENTIFIED: InspectorStateModel = { state: 'unidentified', label: 'Unidentified', onClearAnyEdition: null, discogsOnly: false, links: [] };

const TOOLS: InspectorTool[] = [
  { key: 'tag', label: 'Tag…', onSelect: noop },
  { key: 'move', label: 'Move songs…', onSelect: noop },
  { key: 'manual', label: 'Match to a release', onSelect: noop },
  { key: 'rescan', label: 'Rescan folder', onSelect: noop },
];

const MISSING = (
  <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
    <li>3 · Une année sans lumière · 3:41</li>
    <li>7 · Wake Up · 5:35</li>
  </ul>
);
const body = (item: AttentionItem): ReactNode => (item.id === 'gap:g-missing' ? MISSING : <span>{item.line}</span>);

interface Frame {
  album: AttentionAlbum;
  state?: InspectorStateModel;
  /** ids gone since the first read: ticked off */
  fixed?: string[];
  open?: string[];
  picked?: number;
  section?: AlbumTab;
  live?: boolean;
  note?: string;
}

function useInspector(f: Frame): Omit<MaintenanceInspectorProps, 'variant'> {
  const all = attentionItems(f.album, { now: Date.parse('2026-11-05T12:00:00Z') });
  const [section, setSection] = useState<AlbumTab>(f.section ?? 'tracks');
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set(f.open ?? []));
  const [state] = useState<{ items: AttentionItem[]; ticks: TickState }>(() => {
    const items = all.filter((i) => !f.fixed?.includes(i.id));
    let ticks = reconcileTicks(EMPTY_TICKS, all, 1);
    if (f.fixed?.length) ticks = reconcileTicks(ticks, items, 2);
    return { items, ticks };
  });
  const view = inspectorRows(state.items, state.ticks);
  const selection: InspectorSelection | null = f.picked ? { count: f.picked, all: false, onAll: noop, onMove: noop, deleteLabel: 'Mark for deletion', onDelete: noop, onClear: noop } : null;
  return {
    state: f.state ?? MATCHED,
    rows: view.rows,
    meter: view.meter,
    openRows,
    onToggle: (id) => setOpenRows((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; }),
    onAction: noop,
    body,
    note: f.note ? { text: f.note, live: true, onDismiss: noop } : null,
    selection,
    tools: TOOLS,
    sections: { value: section, onChange: setSection, live: !!f.live },
  };
}

/** The desktop sidebar: the inspector at its width, on the surface beside the album. */
function Side(f: Frame) {
  const p = useInspector(f);
  return (
    <aside aria-label="Maintenance" style={{ width: 320, boxSizing: 'border-box', padding: '22px 20px 32px', background: 'var(--surface)', borderLeft: '1px solid var(--line)' }}>
      <MaintenanceInspector variant="side" {...p} />
    </aside>
  );
}

/** The phone: the one row under the album, and the floating bar while songs are picked. */
function PhoneRow(f: Frame) {
  const p = useInspector(f);
  const selection = p.selection ?? { count: 0, all: false, onAll: noop, onMove: noop, deleteLabel: 'Mark for deletion', onDelete: noop, onClear: noop };
  return (
    <div style={{ position: 'relative', minHeight: 640, padding: '24px 22px', background: 'var(--canvas)' }}>
      <MaintenanceSummary meter={p.meter} open={false} onOpen={noop} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
        <PickBar selection={selection} />
      </div>
    </div>
  );
}

function PhoneSheet(f: Frame) {
  const p = useInspector(f);
  const [open, setOpen] = useState(true);
  return <MaintenanceSheet {...p} open={open} onOpenChange={setOpen} />;
}

const meta = {
  title: 'Album/Maintenance inspector',
  parameters: {
    docs: {
      description: {
        component: 'Maintenance on the album page: one inspector with State, To fix (a meter and one line per issue), Selection, Tools and Sections. A full-height sidebar from 1024px; below it, one "To fix" row that opens the same groups in a sheet, and a floating bar while songs are picked.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeIssues: Story = { name: 'Matched, three issues', render: () => <Side album={FUNERAL} /> };
export const OneFixed: Story = { name: 'One ticked off', render: () => <Side album={FUNERAL} fixed={['gap:g-art']} /> };
export const NothingToFix: Story = { name: 'Nothing to fix', render: () => <Side album={{ ...FUNERAL, gaps: [], missingTracks: [] }} /> };
export const Compilation: Story = { name: 'Unidentified compilation', render: () => <Side album={COMPILATION} state={UNIDENTIFIED} /> };
export const Picked: Story = { name: 'Songs picked', render: () => <Side album={FUNERAL} picked={2} /> };
export const Expanded: Story = { name: 'An issue open', render: () => <Side album={FUNERAL} open={['gap:g-missing']} /> };
export const Section: Story = { name: 'A section open', render: () => <Side album={FUNERAL} section="editions" live note="Looking for cover art…" /> };
export const Row: Story = { name: 'Phone row', tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <PhoneRow album={FUNERAL} picked={2} /> };
export const Sheet: Story = { name: 'Phone sheet', tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <PhoneSheet album={FUNERAL} /> };
