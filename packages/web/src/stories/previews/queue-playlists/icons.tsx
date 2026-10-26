/** Preview-only glyphs, drawn like components/ui/icons.tsx (24 grid, 1.8 stroke, currentColor). */
const S = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, focusable: false };

export const PlusIcon = () => <svg {...S}><path d="M12 5v14M5 12h14" /></svg>;
export const GripIcon = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="9" cy="7" r="1.4" /><circle cx="15" cy="7" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="17" r="1.4" /><circle cx="15" cy="17" r="1.4" /></svg>;
/** a line with an arrow into the top: play next */
export const PlayNextIcon = () => <svg {...S}><path d="M4 6h9M4 11h9M4 16h6" /><path d="M16 10v9M13 16l3 3 3-3" /></svg>;
/** lines with a plus at the end: add to queue */
export const AddQueueIcon = () => <svg {...S}><path d="M4 6h14M4 11h14M4 16h8" /><path d="M17.5 13.5v6M14.5 16.5h6" /></svg>;
/** a stack with a note: playlist */
export const PlaylistIcon = () => <svg {...S}><path d="M4 6h11M4 11h11M4 16h6" /><circle cx="16.5" cy="17" r="2.2" /><path d="M18.7 17V8.5l2.3-1" /></svg>;
export const ExportIcon = () => <svg {...S}><path d="M12 15V4M8 8l4-4 4 4" /><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></svg>;
export const ImportIcon = () => <svg {...S}><path d="M12 4v11M8 11l4 4 4-4" /><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></svg>;
export const RenameIcon = () => <svg {...S}><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>;
export const TrashIcon = () => <svg {...S}><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" /></svg>;
export const ChevronRightIcon = () => <svg {...S}><path d="M9.5 6 15.5 12l-6 6" /></svg>;
export const ChevronDownBigIcon = () => <svg {...S} strokeWidth={2}><path d="M6 9.5 12 15.5l6-6" /></svg>;
export const RepeatIcon = () => <svg {...S}><path d="M5 11V9a3 3 0 0 1 3-3h11M16 3l3 3-3 3M19 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3" /></svg>;
export const SaveIcon = () => <svg {...S}><path d="M4 6h11M4 11h11M4 16h7" /><path d="M14 16.5l2.5 2.5L21 14.5" /></svg>;
export const CheckIcon = () => <svg {...S}><path d="M5 12.5 10 17l9-10" /></svg>;
export const ExpandIcon = () => <svg {...S}><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg>;
export const LibraryIcon = () => <svg {...S}><path d="M5 4v16M10 4v16M15 5l4 15" /></svg>;
