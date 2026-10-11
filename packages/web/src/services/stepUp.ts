/**
 * Step-up: confirm it is you before a sensitive action (today: starting an
 * in-app update). The server decides whether this session is fresh enough
 * (a sign-in or a re-verification within five minutes) and which methods the
 * account has; this file performs the re-verification.
 *
 * The passkey path uses the WebAuthn API directly with the server's
 * options (the same JSON @simplewebauthn/server produces), so it needs no
 * extra package.
 */
import type { StepUpStatus } from '@liner/shared';
import { api } from './api';

export function getStepUp(): Promise<StepUpStatus> {
  return api.get<StepUpStatus>('/auth/step-up');
}

export function stepUpWithPassword(password: string): Promise<StepUpStatus> {
  return api.post<StepUpStatus>('/auth/step-up/password', { password });
}

export function stepUpWithTotp(code: string): Promise<StepUpStatus> {
  return api.post<StepUpStatus>('/auth/step-up/totp', { code: code.replace(/\s+/g, '') });
}

const fromB64url = (s: string): ArrayBuffer => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

const toB64url = (buf: ArrayBuffer | null): string | undefined => {
  if (!buf) return undefined;
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

interface RequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: Array<{ id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }>;
}

export async function stepUpWithPasskey(): Promise<StepUpStatus> {
  if (typeof navigator === 'undefined' || !navigator.credentials || typeof PublicKeyCredential === 'undefined') {
    throw new Error('This browser cannot use passkeys.');
  }
  const opts = await api.post<RequestOptionsJSON>('/auth/step-up/passkey/options');
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: fromB64url(opts.challenge),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
    ...(opts.rpId ? { rpId: opts.rpId } : {}),
    userVerification: opts.userVerification ?? 'required',
    allowCredentials: (opts.allowCredentials ?? []).map((c) => ({
      id: fromB64url(c.id),
      type: 'public-key' as const,
      ...(c.transports ? { transports: c.transports } : {}),
    })),
  };
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was used.');
  const res = cred.response as AuthenticatorAssertionResponse;
  const response = {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      authenticatorData: toB64url(res.authenticatorData),
      clientDataJSON: toB64url(res.clientDataJSON),
      signature: toB64url(res.signature),
      userHandle: toB64url(res.userHandle),
    },
  };
  return api.post<StepUpStatus>('/auth/step-up/passkey', { response });
}
