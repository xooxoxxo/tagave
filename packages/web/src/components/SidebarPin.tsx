/**
 * The pieces of Auto-hide that sit in the sidebar and on the page's edge
 * (behaviour in sidebarPeek.ts): the quiet Pin item at the foot of the nav
 * list, and the faint accent mark on the left edge while the sidebar hides.
 * Layout and the stories' DesktopFrame both render them.
 */
import styles from './Layout.module.css';

export function SidebarPin({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={styles.pinItem} onClick={onToggle} aria-keyshortcuts="Meta+\ Control+\"
      aria-label={pinned ? 'Unpin the sidebar' : 'Pin the sidebar'}>
      <span>{pinned ? 'Unpin' : 'Pin'}</span> <kbd aria-hidden="true">⌘ \</kbd>
    </button>
  );
}

export function PeekMark() {
  return <span className={styles.peekMark} aria-hidden="true" data-peek-mark="" />;
}
