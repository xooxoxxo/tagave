/**
 * Music Connections consent (/connect/consent?request=…): another music app
 * asks to read this person's data. The page names the app, the host the
 * answer goes back to and each scope in plain words; Approve or Deny sends
 * the browser back to that app. Only the signed-in person's own data is ever
 * shared (spec §2, Linking).
 */
import { useEffect, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type ApiError } from '../services/api';
import { useMe } from '../hooks';
import { Button } from '../components/ui';
import { forgetConsentRequest, isConsentRequestId } from './connectReturn';
import styles from './ConnectConsentPage.module.css';

export interface ConsentRequestView {
  client: { name: string; redirectHost: string; secure: boolean };
  scopes: Array<{ scope: string; label: string }>;
}

export function ConnectConsentPage() {
  const { request } = useSearch({ from: '/connect/consent' });
  const { data: user } = useMe();
  const valid = isConsentRequestId(request);
  const view = useQuery({
    queryKey: ['connect-request', request],
    queryFn: () => api.get<ConsentRequestView>(`/connect/requests/${encodeURIComponent(request!)}`),
    enabled: valid && Boolean(user),
    retry: false,
    staleTime: Infinity,
  });
  // back here after signing in: the sign-in return has done its job
  useEffect(() => {
    if (user) forgetConsentRequest();
  }, [user]);
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'approve' | 'deny') => {
    setPending(decision);
    setError(null);
    try {
      const { redirect } = await api.post<{ redirect: string }>(`/connect/requests/${encodeURIComponent(request!)}/decision`, { decision });
      window.location.assign(redirect);
    } catch (err) {
      setPending(null);
      setError((err as ApiError).detail ?? 'That did not work. Try again.');
    }
  };

  if (!valid || view.isError) {
    return (
      <ConsentShell>
        <h1 className={styles.title}>Link request not found</h1>
        <p className={styles.lede}>
          {(view.error as ApiError | null)?.detail ?? 'This link request has expired or was already answered. Start the link again from the other app.'}
        </p>
      </ConsentShell>
    );
  }
  if (!view.data) {
    return (
      <ConsentShell>
        <p className={styles.lede} aria-busy="true">Loading…</p>
      </ConsentShell>
    );
  }
  return (
    <ConsentShell>
      <ConsentCard view={view.data} account={user?.email ?? null} pending={pending} error={error} onDecide={(d) => void decide(d)} />
    </ConsentShell>
  );
}

function ConsentShell({ children }: { children: React.ReactNode }) {
  return (
    <main className={styles.container}>
      <div className={styles.card}>{children}</div>
    </main>
  );
}

/** What the person decides on (also rendered on its own in tests). */
export function ConsentCard({
  view,
  account,
  pending,
  error,
  onDecide,
}: {
  view: ConsentRequestView;
  account: string | null;
  pending: 'approve' | 'deny' | null;
  error: string | null;
  onDecide: (decision: 'approve' | 'deny') => void;
}) {
  const grants = view.scopes.filter((s) => s.scope !== 'offline_access');
  const lasting = view.scopes.some((s) => s.scope === 'offline_access');
  return (
    <>
      <p className={styles.eyebrow}>Music Connections</p>
      <h1 className={styles.title}>Link {view.client.name}?</h1>
      <p className={styles.lede}>
        <strong>{view.client.name}</strong> at <code className={styles.host}>{view.client.redirectHost}</code> asks to:
      </p>
      <ul className={styles.scopes}>
        {grants.map((s) => (
          <li key={s.scope}>{s.label}</li>
        ))}
      </ul>
      <p className={styles.note}>
        Only your own data{account ? <> (signed in as {account})</> : null}, never anyone else’s on this tagave.
        {lasting ? ' The access lasts until you revoke it from the other app.' : ' The access ends after an hour.'}
        {view.client.secure ? '' : ' The link runs over plain HTTP on your private network.'}
      </p>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={styles.actions}>
        <Button onClick={() => onDecide('approve')} loading={pending === 'approve'} disabled={pending !== null}>
          Approve
        </Button>
        <Button variant="secondary" onClick={() => onDecide('deny')} loading={pending === 'deny'} disabled={pending !== null}>
          Deny
        </Button>
      </div>
    </>
  );
}
