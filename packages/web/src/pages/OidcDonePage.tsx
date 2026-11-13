/**
 * /auth/oidc-done: where the login service sends a re-verification back. In
 * the popup the dialog opened, it tells that page (OIDC_DONE_CHANNEL) and
 * closes; opened in the same tab (popups blocked), it offers the way back.
 */
import { useEffect, useState } from 'react';
import { LinkButton } from '../components/ui';
import { OIDC_DONE_CHANNEL } from '../services/oidc';
import styles from './SetupPage.module.css';

export function OidcDonePage() {
  const [ok] = useState(() => new URLSearchParams(window.location.search).get('oidc') !== 'failed');
  useEffect(() => {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(OIDC_DONE_CHANNEL);
      channel.postMessage({ ok });
      channel.close();
    }
    if (window.opener) window.close();
  }, [ok]);
  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>tagave</h1>
        <section className={styles.section}>
          <h2 className={styles.heading}>{ok ? 'Confirmed' : 'Not confirmed'}</h2>
          <div className={styles.actions}><LinkButton to="/" variant="secondary">Back</LinkButton></div>
        </section>
      </div>
    </div>
  );
}
