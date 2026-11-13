/**
 * The albums' filters on a phone: the filter rail as a sheet from the bottom
 * edge (components/ui/Sheet, the album page's ⋮ drawer), over the list
 * instead of beside it. Loaded only when it first opens.
 */
import type { ComponentProps, RefObject } from 'react';
import { Sheet } from '../components/ui/Sheet';
import { FilterRail } from '../components/FilterRail';

export interface AlbumsFilterSheetProps extends Omit<ComponentProps<typeof FilterRail>, 'variant'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus?: RefObject<HTMLElement | null>;
}

export default function AlbumsFilterSheet({ open, onOpenChange, returnFocus, ...rail }: AlbumsFilterSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Filters" returnFocus={returnFocus}>
      <FilterRail {...rail} variant="sheet" />
    </Sheet>
  );
}
