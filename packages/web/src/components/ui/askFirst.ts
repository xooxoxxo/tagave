/**
 * The confirms the settings pages ask before an action that loses
 * something one click cannot get back, or stops work in progress
 * (DESIGN.md, Confirms). Each is the danger tone with its title as the
 * question. A price's Remove asks nothing: adding it again is one click.
 */
import { confirmDialog, type ConfirmOptions } from './ConfirmDialog';

export const ASK_FIRST = {
  forgetDiscogsToken: { title: 'Forget the Discogs token?', message: 'Discogs lookups stop until a token is set again.', confirmLabel: 'Forget' },
  forgetAcoustidKey: { title: 'Forget the AcoustID key?', message: 'Fingerprint lookups stop until a key is set again.', confirmLabel: 'Forget' },
  forgetJevKey: { title: 'Forget the Jev key?', message: 'Jev stops deciding until a key is set again.', confirmLabel: 'Forget' },
  forgetClientSecret: { title: 'Forget the client secret?', message: 'Signing in with the service stops until a secret is set again.', confirmLabel: 'Forget' },
  cancelRun: { title: 'Cancel this run?', message: 'Albums not yet decided stay undecided. A cancelled run cannot be resumed.', confirmLabel: 'Cancel run', cancelLabel: 'Keep running' },
  revokeLink: { title: 'Revoke this link?', message: 'It stops working at once. You can make a new one.', confirmLabel: 'Revoke' },
  useSharedLogin: { title: 'Use the shared account?', message: 'Your own login is forgotten here. You can add it again with its password.', confirmLabel: 'Use shared' },
} satisfies Record<string, Omit<ConfirmOptions, 'tone'>>;

export type AskFirst = keyof typeof ASK_FIRST;

/** Ask before `action`; resolves true when the person confirms. */
export function askFirst(action: AskFirst): Promise<boolean> {
  return confirmDialog({ ...ASK_FIRST[action], tone: 'danger' });
}
