/**
 * Passkeys and security keys through Better Auth's passkey plugin. A
 * security key (YubiKey) is a cross-platform authenticator; "passkey" lets
 * the browser offer whatever it has (iCloud Keychain, Google Password
 * Manager, Windows Hello, a phone, or a key).
 */
import { WebAuthnAbortService } from '@simplewebauthn/browser';
import { authClient, type AuthClientError } from './authClient';

export type PasskeyKind = 'passkey' | 'security-key';

export interface PasskeyResult {
  ok: boolean;
  error?: AuthClientError | undefined;
}

export async function addPasskey(kind: PasskeyKind, name?: string): Promise<PasskeyResult> {
  const res = await authClient().passkey.addPasskey({
    ...(name ? { name } : {}),
    ...(kind === 'security-key' ? { authenticatorAttachment: 'cross-platform' as const } : {}),
  });
  return res?.error ? { ok: false, error: res.error } : { ok: true };
}

/**
 * Sign in with a passkey. With `autoFill`, the browser offers passkeys in the
 * email field's autofill list (conditional UI) and this resolves only when
 * one is picked.
 */
export async function signInWithPasskey(autoFill = false): Promise<PasskeyResult> {
  const res = await authClient().signIn.passkey({ autoFill });
  return res?.error ? { ok: false, error: res.error } : { ok: true };
}

/**
 * End the passkey request still open, if any. The sign-in page's autofill
 * request otherwise stays open after the page is left (this is a single-page
 * app), and a page can hold only one WebAuthn request.
 */
export function endPasskeyRequest(): void {
  WebAuthnAbortService.cancelCeremony();
}

export async function renamePasskey(id: string, name: string): Promise<PasskeyResult> {
  const res = await authClient().$fetch('/passkey/update-passkey', { method: 'POST', body: { id, name } });
  return res.error ? { ok: false, error: res.error as AuthClientError } : { ok: true };
}

export async function deletePasskey(id: string): Promise<PasskeyResult> {
  const res = await authClient().$fetch('/passkey/delete-passkey', { method: 'POST', body: { id } });
  return res.error ? { ok: false, error: res.error as AuthClientError } : { ok: true };
}

/** Whether this browser can do conditional UI (passkeys in the autofill list). */
export async function conditionalUiAvailable(): Promise<boolean> {
  const pkc = (globalThis as { PublicKeyCredential?: { isConditionalMediationAvailable?: () => Promise<boolean> } }).PublicKeyCredential;
  try {
    return Boolean(pkc?.isConditionalMediationAvailable && (await pkc.isConditionalMediationAvailable()));
  } catch {
    return false;
  }
}
