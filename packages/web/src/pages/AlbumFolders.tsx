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

export function AlbumFolders({ folders }: { folders: AlbumFolder[] }) {
  const anyLink = folders.some((f) => f.link);
  return (
    <div className={styles.folders}>
      {folders.map((f) => (
        <div key={f.path} className={styles.folder}>
          <span className={styles.path}>{f.path || '(top of the music folder)'}</span>
          <div className={styles.actions}>
            {f.link && (
              <a className={buttonClassName({ variant: 'secondary', size: 'sm', className: styles.open })} href={f.link} title={`Open ${f.link}`}>
                <span className={buttonLabelClassName}><FolderIcon />Open folder</span>
              </a>
            )}
            <LinkButton variant="quiet" size="sm" to="/albums" search={{ folder: f.path } as never}>Show albums in this folder</LinkButton>
            <Button
              variant="quiet"
              size="sm"
              onClick={async () => {
                const ok = await copyText(f.path);
                showToast({ message: ok ? 'Folder path copied' : 'Could not copy: select the path and copy it instead', tone: ok ? 'neutral' : 'danger', durationMs: 3500 });
              }}
            >
              Copy path
            </Button>
          </div>
        </div>
      ))}
      {!anyLink && (
        <p className={styles.hint}>
          <Link to="/settings/$section" params={{ section: 'library' }}>Set a folder link in Settings</Link> to open this folder from here.
        </p>
      )}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}
