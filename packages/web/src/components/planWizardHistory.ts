/**
 * Where the tag plan wizard sends the browser, and how it touches history.
 *
 * The album page's "Fix tags" opens the wizard by pushing /plans?album=<id>.
 * That history entry exists only to show the wizard, so once the plan exists
 * (or the wizard is dismissed) it must not stay behind: Back would land on it
 * and open the wizard again for a flow that is already finished. Both exits
 * replace it instead of pushing on top of it.
 */

/** The plan page after a plan was created or albums were added to it. */
export function planDoneNavigation(planId: string, replaceWizardEntry: boolean) {
  return { to: '/plans/$planId' as const, params: { planId }, replace: replaceWizardEntry };
}

/**
 * Closing a wizard that the URL opened (?album=): drop the parameter in place,
 * so Back goes to the page before the wizard. A wizard opened by a button
 * lives in component state and needs no navigation (null).
 */
export function wizardCloseNavigation(albumParam: string | undefined) {
  return albumParam ? { to: '/plans' as const, search: {}, replace: true } : null;
}
