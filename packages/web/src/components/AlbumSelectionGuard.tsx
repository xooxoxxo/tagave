import { useBlocker } from '@tanstack/react-router';
import { confirmDialog } from './ui';
import { parseAlbumsSearch } from '../pages/albumsSearch';
import {
  albumsSelectionKey, clearAlbumSelection, getAlbumListMemory, leaveMessage, selectionLeaveRule, selectionSize,
} from '../pages/albumSelection';

/**
 * Asks before a navigation drops the album selection: into an album and back
 * keeps it, anywhere else asks "Leave and clear…?" and clears on accept.
 * Router navigations and the browser's back/forward both pass through here.
 */
export function AlbumSelectionGuard() {
  useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: async ({ current, next }) => {
      const memory = getAlbumListMemory();
      const count = selectionSize(memory);
      const toPath = next.pathname;
      const rule = selectionLeaveRule({
        count,
        selectionKey: memory.queryKey,
        fromPath: current.pathname,
        toPath,
        toKey: /^\/albums\/?$/.test(toPath) ? albumsSelectionKey(parseAlbumsSearch((next.search ?? {}) as Record<string, unknown>)) : null,
      });
      if (rule === 'allow') return false;
      const ok = await confirmDialog({
        title: leaveMessage(count),
        message: 'The albums themselves are not changed; only the selection is dropped.',
        confirmLabel: 'Leave and clear',
        cancelLabel: 'Stay',
      });
      if (!ok) return true;
      clearAlbumSelection();
      return false;
    },
  });
  return null;
}
