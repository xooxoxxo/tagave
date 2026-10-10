/**
 * Freshly made backup codes, shown once: download as .txt, print, and an
 * "I saved these" confirmation before the panel can be closed.
 */
import { useState } from 'react';
import { Banner, Button } from './ui';
import { backupCodesFile } from '../pages/securityModel';
import styles from './BackupCodesPanel.module.css';

interface Props {
  codes: string[];
  email: string;
  onDone: () => void;
}

export function BackupCodesPanel({ codes, email, onDone }: Props) {
  const [saved, setSaved] = useState(false);
  const text = backupCodesFile(codes, email, window.location.origin);

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tagave-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const print = () => {
    const w = window.open('', '_blank', 'noopener,width=480,height=640');
    if (!w) return;
    w.document.title = 'tagave backup codes';
    const pre = w.document.createElement('pre');
    pre.textContent = text;
    pre.style.font = '14px/1.6 ui-monospace, monospace';
    w.document.body.appendChild(pre);
    w.print();
  };

  return (
    <div className={styles.panel}>
      <Banner tone="warning">
        These backup codes are shown only now. Each one signs you in once if you lose your authenticator app or passkeys.
        Save them somewhere away from this computer.
      </Banner>
      <ol className={styles.codes} aria-label="Backup codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={download}>Download .txt</Button>
        <Button variant="secondary" onClick={print}>Print</Button>
      </div>
      <label className={styles.confirm}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I saved these codes
      </label>
      <div>
        <Button onClick={onDone} disabled={!saved}>Done</Button>
      </div>
    </div>
  );
}
