/**
 * Settings' section list from a search: each hit is a link to its section,
 * the indexed labels that matched as a quiet second line. The owner's update
 * dot stays on Updates. A plain module, so stories and tests build the list
 * the page shows.
 */
import type { SectionNavItem } from '../components/settings/SectionNav';
import type { SearchHit } from './settingsIndex';

export function settingsNavItems(hits: readonly SearchHit[], updateAvailable: boolean): SectionNavItem[] {
  return hits.map((hit) => ({
    value: hit.section,
    label: hit.label,
    to: `/settings/${hit.section}`,
    dot: hit.section === 'updates' && updateAvailable,
    ...(hit.matches.length > 0 ? { detail: hit.matches.join(', ') } : {}),
  }));
}
