/**
 * Step-up: confirm it is you before a sensitive action (today: starting an
 * in-app update). The server decides whether this session is fresh enough
 * (a sign-in or a re-verification within five minutes) and which methods the
 * account has; this file performs the re-verification.
 *
 * The passkey path goes through @simplewebauthn/browser, the library Better
 * Auth's passkey sign-in uses. Only one WebAuthn request can be open in a
 * page, and its abort service ends the one still open (the sign-in page's
 * autofill request outlives that page in this single-page app) before it
 * starts ours. Before, this called navigator.credentials.get directly with
 * no signal, so it could neither end that request nor be stopped itself.
 */
import { WebAuthnAbortService, browserSupportsWebAuthn, startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type { StepUpStatus } from '@liner/shared';
import { api } from './api';

/** How long the dialog waits for a passkey before it stops the request. */
export const PASSKEY_TIMEOUT_MS = 60_000;

export function getStepUp(): Promise<StepUpStatus> {
  return api.get<StepUpStatus>('/auth/step-up');
}

export function stepUpWithPassword(password: string, signal?: AbortSignal): Promise<StepUpStatus> {
  return api.post<StepUpStatus>('/auth/step-up/password', { password }, signal ? { signal } : undefined);
}

export function stepUpWithTotp(code: string, signal?: AbortSignal): Promise<StepUpStatus> {
  return api.post<StepUpStatus>('/auth/step-up/totp', { code: code.replace(/\s+/g, '') }, signal ? { signal } : undefined);
}

/**
 * Re-verify with a passkey. Aborting `signal` ends the browser's passkey
 * request too, and the promise rejects with the signal's reason.
 */
export async function stepUpWithPasskey(signal?: AbortSignal): Promise<StepUpStatus> {
  if (!browserSupportsWebAuthn()) throw new Error('This browser cannot use passkeys.');
  const optionsJSON = await api.post<PublicKeyCredentialRequestOptionsJSON>('/auth/step-up/passkey/options', undefined, signal ? { signal } : undefined);
  signal?.throwIfAborted();
  const stop = () => WebAuthnAbortService.cancelCeremony();
  signal?.addEventListener('abort', stop, { once: true });
  let response;
  try {
    // The browser's own timeout is set past ours so the dialog's timeout,
    // with its own message, is the one that ends a request nobody answers.
    response = await startAuthentication({ optionsJSON: { ...optionsJSON, timeout: PASSKEY_TIMEOUT_MS + 10_000 } });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw err;
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  signal?.throwIfAborted();
  return api.post<StepUpStatus>('/auth/step-up/passkey', { response }, signal ? { signal } : undefined);
}

/** What the dialog says when a re-verification fails, in plain words. */
export function stepUpErrorMessage(err: unknown, origin = typeof window === 'undefined' ? '' : window.location.origin): string {
  if (!err || typeof err !== 'object') return 'That did not work. Try again.';
  const e = err as { name?: string; code?: string; detail?: string; message?: string; status?: number };
  switch (e.name) {
    case 'TimeoutError':
      return `No passkey answered within ${PASSKEY_TIMEOUT_MS / 1000} seconds. Try again.`;
    case 'NotAllowedError':
      return 'No passkey was used: the prompt was closed or timed out, or the passkey did not check your PIN or fingerprint.';
    case 'AbortError':
      return 'The passkey request was stopped. Try again.';
    case 'InvalidStateError':
    case 'OperationError':
      return 'Another passkey request is still open in this browser. Close it, then try again.';
    case 'SecurityError':
      return `Passkeys work only at the address set as PUBLIC_URL, over https or on localhost. This page is ${origin || 'at another address'}.`;
  }
  if (e.status === 0 || e.name === 'TypeError') return 'Cannot reach tagave. Check that the server is running.';
  return e.detail ?? e.message ?? 'That did not work. Try again.';
}
