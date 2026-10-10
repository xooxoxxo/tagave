/**
 * What the sign-in pages say for each Better Auth failure, kept free of
 * React so it can be tested.
 */
import type { AuthClientError } from '../services/authClient';

export function signInErrorMessage(error: AuthClientError | null | undefined, origin = currentOrigin()): string {
  if (!error) return 'Sign-in failed. Try again.';
  const code = error.code ?? '';
  const status = error.status ?? 0;
  if (code === 'INVALID_EMAIL_OR_PASSWORD' || code === 'INVALID_PASSWORD' || code === 'INVALID_EMAIL') {
    return 'Wrong email or password.';
  }
  if (status === 429 || code === 'TOO_MANY_REQUESTS') {
    return 'Too many attempts. Wait a few seconds, then try again.';
  }
  if (code === 'INVALID_ORIGIN' || code === 'MISSING_OR_NULL_ORIGIN' || code === 'CROSS_SITE_NAVIGATION_LOGIN_BLOCKED') {
    return (
      `tagave does not accept sign-ins from ${origin || 'this address'}. Open it at the address set as PUBLIC_URL, ` +
      'or add this address to ALLOWED_ORIGINS in .env and restart the app.'
    );
  }
  if (code === 'INVALID_CODE' || code === 'INVALID_TWO_FACTOR_AUTHENTICATION') return 'That code is not right. Try the current one.';
  if (code === 'INVALID_BACKUP_CODE') return 'That backup code is not right, or it was used already.';
  if (code === 'INVALID_TWO_FACTOR_COOKIE') return 'This sign-in took too long. Enter your email and password again.';
  if (code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' || code === 'ACCOUNT_TEMPORARILY_LOCKED') {
    return 'Too many wrong codes. Wait 15 minutes, or sign in with a passkey or a backup code.';
  }
  if (status === 0) return 'Cannot reach tagave. Check that the server is running.';
  if (status >= 500) return 'The server failed to sign you in. Check the app logs, then try again.';
  return error.message || 'Sign-in failed. Try again.';
}

function currentOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}
