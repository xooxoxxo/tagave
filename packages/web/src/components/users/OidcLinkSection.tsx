/**
 * Settings › Account: this person's link to the login service. Linking is
 * explicit (never by a matching email) and asks for a fresh confirmation
 * first; unlinking is refused while it is the only way in.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OidcLinkView } from '@tagave/shared';
import { Badge, Banner, Button, confirmDialog } from '../ui';
import { OIDC_LINK_KEY, startOidcLink, unlinkOidc, useOidcLink } from '../../services/oidc';
import { shortDate } from '../../utils/time';
import { useStepUpAction } from './useStepUpAction';
import styles from '../../pages/SettingsSecurityPage.module.css';

const errorText = (err: unknown, fallback: string) => {
  const e = err as { detail?: string } | null;
  return e?.detail ?? fallback;
};

export interface OidcLinkViewProps {
  view: OidcLinkView;
  busy?: boolean;
  /** Back from the service: 'linked' or 'failed'. */
  returned?: string | null;
  error?: string | null;
  onLink: () => void;
  onUnlink: () => void;
}

/** The section, without data fetching (Storybook renders it with fixtures). */
export function OidcLinkPanel({ view, busy = false, returned = null, error = null, onLink, onUnlink }: OidcLinkViewProps) {
  const name = view.name ?? 'Login service';
  return (
    <section className={styles.section} aria-labelledby="account-oidc">
      <h3 id="account-oidc" className={styles.title}>{name}</h3>
      <div className={styles.item}>
        <div>
          {view.linked
            ? <><Badge tone="success">Linked</Badge>{view.linkedAt && <span className={styles.muted}> {shortDate(view.linkedAt, { time: false })}</span>}</>
            : <Badge tone="neutral">Not linked</Badge>}
        </div>
        {view.linked
          ? <Button size="sm" variant="secondary" onClick={onUnlink} disabled={busy || !view.canUnlink}>Unlink</Button>
          : view.name && <Button size="sm" onClick={onLink} loading={busy}>Link</Button>}
      </div>
      {returned === 'failed' && <Banner tone="danger">Couldn’t link {name}.</Banner>}
      {error && <Banner tone="danger">{error}</Banner>}
    </section>
  );
}

export function OidcLinkSection() {
  const link = useOidcLink();
  const queryClient = useQueryClient();
  const { run, dialog } = useStepUpAction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [returned] = useState(() => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('oidc')));

  const view = link.data;
  if (!view || (!view.name && !view.linked)) return null;

  const onLink = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await run(`Link ${view.name}`, () => startOidcLink());
      if (res) {
        window.location.assign(res.url);
        return;
      }
    } catch (err) {
      setError(errorText(err, 'Could not start the link.'));
    }
    setBusy(false);
  };

  const onUnlink = async () => {
    const name = view.name ?? 'the login service';
    const ok = await confirmDialog({ title: `Unlink ${name}?`, confirmLabel: 'Unlink', tone: 'danger' });
    if (!ok) return;
    setError(null);
    setBusy(true);
    try {
      await unlinkOidc();
      await queryClient.invalidateQueries({ queryKey: OIDC_LINK_KEY });
    } catch (err) {
      setError(errorText(err, 'Could not unlink.'));
    }
    setBusy(false);
  };

  return (
    <>
      <OidcLinkPanel view={view} busy={busy} returned={returned} error={error} onLink={() => void onLink()} onUnlink={() => void onUnlink()} />
      {dialog}
    </>
  );
}
