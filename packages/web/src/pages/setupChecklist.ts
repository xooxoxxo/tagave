/**
 * The setup checklist is a first-run thing: Home shows it to the owner while
 * a required step (contact, a music folder that checks out, the first scan)
 * is open, until the owner dismisses it. Settings keeps its route for direct
 * links, out of the nav.
 */
import type { LibrarySettingsView, ScanRoot } from '@tagave/shared';

type Settings = Pick<LibrarySettingsView, 'contactString' | 'onboardingCompletedAt'> & { setupChecklistDismissedAt?: string | null };
type Roots = Pick<ScanRoot, 'validationStatus'>[];

/** Every required step is done. */
export function setupComplete(settings: Settings, roots: Roots): boolean {
  return !!settings.contactString && roots.some((r) => r.validationStatus === 'ok') && !!settings.onboardingCompletedAt;
}

/** Home shows the checklist: to the owner, once loaded, while a step is open and it was not dismissed. */
export function showSetupChecklist(owner: boolean, settings: Settings | undefined, roots: Roots | undefined): boolean {
  if (!owner || !settings || !roots) return false;
  if (settings.setupChecklistDismissedAt) return false;
  return !setupComplete(settings, roots);
}
