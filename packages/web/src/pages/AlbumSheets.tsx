/**
 * The album's two drawers, on Base UI's Drawer (components/ui/Sheet): the ⋮
 * drawer on a phone or tablet, and Album info (a side sheet on a desktop).
 * The page loads this file only when one first opens, so the drawer library
 * is not part of the album page's own chunk.
 */
import { useId, useState, type RefObject } from 'react';
import { Tabs, tabIdFor } from '../components/ui';
import { Sheet } from '../components/ui/Sheet';
import { AlbumActionsBody, AlbumSummaryHead, type AlbumInfoTab, type AlbumSummary } from './AlbumMenu';
import type { AlbumMenuModel } from './albumActions';
import styles from './AlbumMenu.module.css';

export interface AlbumActionsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus?: RefObject<HTMLElement | null>;
  summary: AlbumSummary;
  model: AlbumMenuModel;
}

/** The ⋮ drawer on a phone. Picking anything closes it first. */
export function AlbumActionsSheet({ open, onOpenChange, returnFocus, summary, model }: AlbumActionsSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`${summary.title}: more`} returnFocus={returnFocus}>
      <AlbumActionsBody summary={summary} model={model} onClose={() => onOpenChange(false)} />
    </Sheet>
  );
}

export interface AlbumInfoSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus?: RefObject<HTMLElement | null>;
  summary: AlbumSummary;
  /** About, Reviews: only the ones with something in them */
  tabs: AlbumInfoTab[];
  /** the tab to show first ("about" from More) */
  initialTab?: string | undefined;
  /** bottom on a phone, a side sheet on a desktop */
  side: 'bottom' | 'right';
}

/** The album info drawer: the summary, pill tabs for what exists, the text. */
export function AlbumInfoSheet({ open, onOpenChange, returnFocus, summary, tabs, initialTab, side }: AlbumInfoSheetProps) {
  const [tab, setTab] = useState<string | null>(initialTab ?? null);
  const [wasOpen, setWasOpen] = useState(open);
  const panelId = useId();
  // each opening starts on the tab it was asked for
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTab(initialTab ?? null);
  }
  const current = tabs.find((t) => t.value === tab) ?? tabs[0];
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`${summary.title}: album info`} side={side} returnFocus={returnFocus}>
      <div className={styles.sheet} data-album-info-sheet="">
        <AlbumSummaryHead summary={summary} />
        {tabs.length > 1 && (
          <div className={styles.infoTabs}>
            <Tabs label="Album info" panelId={panelId} value={current?.value ?? ''} onChange={setTab} items={tabs.map((t) => ({ value: t.value, label: t.label }))} />
          </div>
        )}
        {current && (
          <div
            className={styles.infoPanel}
            {...(tabs.length > 1 ? { id: panelId, role: 'tabpanel', 'aria-labelledby': tabIdFor(panelId, current.value) } : {})}
          >
            {current.content}
          </div>
        )}
      </div>
    </Sheet>
  );
}
