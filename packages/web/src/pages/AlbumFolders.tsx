/**
 * "Local folder" on the album's About face: the path, and three ways to it —
 * the other albums in that folder (in-app), the path on the clipboard, and,
 * when Settings › Library has an open-folder link for the scan root, the
 * folder itself (smb:// opens Finder or Explorer on most systems; browsers
 * usually block file:// links from a web page, so Copy path stays next to it).
 */
import { Link } from '@tanstack/react-router';
import { Button, LinkButton, showToast } from '../components/ui';
import { buttonClassName, buttonLabelClassName } from '../components/ui/Button';
import styles from './AlbumFolders.module.css';

export interface AlbumFolder {
  path: string;
  scanRootId: string | null;
  link: string | null;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // no clipboard permission (http, an old browser): select-and-copy fallback
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Where "Show albums in this folder" goes; null for the top of a music folder (that would be the whole library). */
export function folderAlbumsSearch(f: Pick<AlbumFolder, 'path' | 'scanRootId'>): { folder: string; root?: string } | null {
  if (!f.path) return null;
  return f.scanRootId ? { folder: f.path, root: f.scanRootId } : { folder: f.path };
}

export function AlbumFolders({ folders }: { folders: AlbumFolder[] }) {
  const anyLink = folders.some((f) => f.link);
  return (
    <div className={styles.folders}>
      {folders.map((f) => {
        const albums = folderAlbumsSearch(f);
        return (
          <div key={`${f.scanRootId ?? ''}:${f.path}`} className={styles.folder}>
            <span className={styles.path}>{f.path || '(top of the music folder)'}</span>
            <div className={styles.actions}>
              {f.link && (
                <a className={buttonClassName({ variant: 'secondary', size: 'sm', className: styles.action })} href={f.link} title={`Open ${f.link}`}>
                  <span className={buttonLabelClassName}><FolderIcon />Open folder</span>
                </a>
              )}
              {albums && (
                <LinkButton variant="secondary" size="sm" className={styles.action ?? ''} to="/albums" search={albums as never}>
                  <ListIcon />Show albums in this folder
                </LinkButton>
              )}
              <Button
                variant="secondary"
                size="sm"
                className={styles.action}
                onClick={async () => {
                  const ok = await copyText(f.path);
                  showToast({ message: ok ? 'Folder path copied' : 'Could not copy: select the path and copy it instead', tone: ok ? 'neutral' : 'danger', durationMs: 3500 });
                }}
              >
                <CopyIcon />Copy path
              </Button>
            </div>
          </div>
        );
      })}
      {!anyLink && (
        <p className={styles.hint}>
          <Link to="/settings/$section" params={{ section: 'library' }}>Set a folder link in Settings</Link> to open this folder from here.
        </p>
      )}
    </div>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="3.5" y="4" width="7" height="7" rx="1.5" /><rect x="13.5" y="4" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="14" width="7" height="7" rx="1.5" /><rect x="13.5" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" /><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}
