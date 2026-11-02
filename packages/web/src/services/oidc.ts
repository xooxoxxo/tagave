/**
 * Sign in with your login service (OpenID Connect). Every flow starts on the
 * server (it decides which flow and keeps the state); the browser only goes
 * to the URL it gets back. Re-verification opens the service in a popup and
 * waits for the step-up to turn fresh, so the action that asked for it can
 * go on in this page.
 */
import { useQuery } from '@tanstack/react-query';
import type { OidcLinkView, OidcPublicView, OidcStartResponse, OidcTestResult, StepUpStatus } from '@tagave/shared';
import { api } from './api';
import { getStepUp } from './stepUp';

export const OIDC_PUBLIC_KEY = ['oidc', 'public'] as const;
export const OIDC_LINK_KEY = ['oidc', 'link'] as const;
export const OIDC_SETTINGS_KEY = ['oidc', 'settings'] as const;

/** The button's name, or null when there is no button. */
export function useOidcButton() {
  return useQuery({ queryKey: OIDC_PUBLIC_KEY, queryFn: () => api.get<OidcPublicView>('/auth/oidc'), staleTime: 60_000, retry: false });
}

export function useOidcLink(enabled = true) {
  return useQuery({ queryKey: OIDC_LINK_KEY, queryFn: () => api.get<OidcLinkView>('/auth/oidc/link'), enabled });
}

/** Leave for the service's sign-in page (sign-in, or an invite's account). */
export async function startOidcSignIn(invite?: string): Promise<void> {
  const { url } = await api.post<OidcStartResponse>('/auth/oidc/sign-in', invite ? { invite } : {});
  window.location.assign(url);
}

export function startOidcLink(): Promise<OidcStartResponse> {
  return api.post<OidcStartResponse>('/auth/oidc/link', {});
}

export function unlinkOidc(): Promise<void> {
  return api.delete<void>('/auth/oidc/link');
}

export function testOidcIssuer(issuer: string): Promise<OidcTestResult> {
  return api.post<OidcTestResult>('/users/sign-in-service/test', { issuer });
}

/** The popup page (/auth/oidc-done) says it is finished on this channel. */
export const OIDC_DONE_CHANNEL = 'tagave-oidc-done';
const POLL_MS = 1500;

/**
 * Re-verify at the login service: a popup to its sign-in page (prompt=login),
 * then wait until this session's step-up is fresh. Closing the popup, the
 * service refusing, or `signal` ends the wait. A browser that blocks popups
 * gets the same tab: the action is then asked for again on return.
 */
export async function stepUpWithOidc(signal?: AbortSignal): Promise<StepUpStatus> {
  const popup = window.open('', 'tagave-oidc', 'popup,width=520,height=700');
  let url: string;
  try {
    url = (await api.post<OidcStartResponse>('/auth/step-up/oidc', {}, signal ? { signal } : undefined)).url;
  } catch (err) {
    popup?.close();
    throw err;
  }
  if (!popup) {
    window.location.assign(url);
    return new Promise<StepUpStatus>(() => undefined);
  }
  popup.location.href = url;
  return new Promise<StepUpStatus>((resolve, reject) => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(OIDC_DONE_CHANNEL);
    let finished = false;
    const end = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      channel?.close();
      signal?.removeEventListener('abort', onAbort);
      if (!popup.closed) popup.close();
      fn();
    };
    const check = async (final = false) => {
      try {
        const status = await getStepUp();
        if (status.fresh && status.methods.includes('oidc')) end(() => resolve(status));
        else if (final) end(() => reject(new Error('The login service did not confirm it is you.')));
      } catch (err) {
        if (final) end(() => reject(err));
      }
    };
    const onAbort = () => end(() => reject(signal?.reason ?? new DOMException('Stopped', 'AbortError')));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (channel) {
      channel.onmessage = (e: MessageEvent<{ ok?: boolean }>) => {
        if (e.data?.ok) void check(true);
        else end(() => reject(new Error('The login service did not confirm it is you.')));
      };
    }
    const timer = setInterval(() => {
      if (popup.closed) void check(true);
      else void check();
    }, POLL_MS);
  });
}
