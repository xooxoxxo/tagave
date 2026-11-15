/**
 * The exact request one album's Jev run would send (GET …/autotagger/preview):
 * the album, its size, and the JSON as sent. The owner marks it Seen before
 * the first run.
 */
import type { PayloadPreview } from '@tagave/shared';
import { Values } from './autotaggerParts';
import { count } from './autotaggerSteps';
import styles from './autotagger.module.css';

export function PayloadPreviewView({ preview }: { preview: PayloadPreview }) {
  return (
    <div className={styles.section}>
      <Values
        label="Payload"
        rows={[
          ['Album', [preview.title, preview.artist].filter(Boolean).join(' · ') || '—'],
          ['Size', `${count(preview.bytes)} bytes`],
          ['Tracklists', count(preview.groups)],
          ['Model', preview.request.model],
        ]}
      />
      <pre className={styles.payload} tabIndex={0} aria-label="Request">{JSON.stringify(preview.request, null, 2)}</pre>
    </div>
  );
}
