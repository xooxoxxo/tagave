/**
 * Settings › Security logic, kept free of React so it can be tested: the
 * account health line, readable names for browsers and authenticators, and
 * the backup-codes file.
 */

export interface PasskeyView {
  id: string;
  name: string | null;
  aaguid: string | null;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  createdAt: string | null;
}

export interface TrustedDeviceView {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}

export interface SecurityStatus {
  /** PUBLIC_URL: passkeys work only at this origin (and only over https or on localhost). */
  config: { publicUrl: string; passkeysAvailable: boolean };
  password: { set: boolean; changedAt: string | null };
  twoFactor: { enabled: boolean; backupCodesLeft: number | null };
  passkeys: PasskeyView[];
  trustedDevices: TrustedDeviceView[];
}

export interface Health {
  tone: 'success' | 'warning' | 'danger';
  /** second factors: each passkey, plus the authenticator app */
  factors: number;
  text: string;
}

/** "2 factors" and its warnings. */
export function accountHealth(s: SecurityStatus): Health {
  const factors = s.passkeys.length + (s.twoFactor.enabled ? 1 : 0);
  if (factors === 0) {
    return {
      tone: 'danger',
      factors,
      text: 'No second factor',
    };
  }
  const codes = s.twoFactor.enabled ? s.twoFactor.backupCodesLeft ?? 0 : 0;
  if (factors === 1) {
    return {
      tone: 'warning',
      factors,
      text:
        codes > 0
          ? `1 factor, ${codes} backup code${codes === 1 ? '' : 's'}`
          : '1 factor. Losing it locks you out.',
    };
  }
  return { tone: 'success', factors, text: `${factors} factors` };
}

/** "Firefox on macOS" from a user-agent string, or a plain fallback. */
export function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return 'Unknown browser';
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'A browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

/** A best-effort name for the authenticator behind a passkey (from its AAGUID). */
const KNOWN_AAGUIDS: Record<string, string> = {
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'Apple Passwords',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  'cb69481e-8ff7-4039-93ec-0a2729a154a8': 'YubiKey 5',
  'ee882879-721c-4913-9775-3dfcce97072a': 'YubiKey 5',
  'fa2b99dc-9e39-4257-8f92-4a30d23c4118': 'YubiKey 5 NFC',
  '2fc0579f-8113-47ea-b116-bb5a8db9202a': 'YubiKey 5 NFC',
  'c5ef55ff-ad9a-4b9f-b580-adebafe026d0': 'YubiKey 5Ci',
  'a4e9fc6d-4cbe-4758-b8ba-37598bb5bbaa': 'Security Key NFC by Yubico',
  'd8522d9f-575b-4866-88a9-ba99fa02f35b': 'YubiKey Bio',
};

export function passkeyLabel(p: PasskeyView): string {
  if (p.name && p.name.trim()) return p.name.trim();
  const known = p.aaguid ? KNOWN_AAGUIDS[p.aaguid.toLowerCase()] : undefined;
  if (known) return known;
  if (p.transports.includes('usb') || p.transports.includes('nfc')) return 'Security key';
  return 'Passkey';
}

/** Synced passkeys live in a password manager; device-bound ones on one key or device. */
export function passkeyKind(p: PasskeyView): string {
  return p.backedUp || p.deviceType === 'multiDevice' ? 'Synced passkey' : 'On this key or device only';
}

/** The text of the backup-codes download. */
export function backupCodesFile(codes: string[], email: string, origin: string, now = new Date()): string {
  return [
    `tagave backup codes for ${email}`,
    `${origin} - made ${now.toISOString().slice(0, 10)}`,
    '',
    'Each code signs you in once when you cannot use your authenticator app or passkey.',
    'Keep them somewhere safe, away from this computer.',
    '',
    ...codes,
    '',
  ].join('\n');
}

/** Why passkeys will not work on this page, or null when they can. */
export function passkeyProblem(config: SecurityStatus['config'], pageOrigin: string): string | null {
  if (!config.passkeysAvailable) {
    return `Passkeys need https (or localhost). PUBLIC_URL is ${config.publicUrl}.`;
  }
  if (pageOrigin && pageOrigin !== config.publicUrl) {
    return `Passkeys are tied to ${config.publicUrl} (PUBLIC_URL). Open tagave there.`;
  }
  return null;
}
