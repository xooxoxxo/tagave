/**
 * Which modules with a part of the person's are on for them (Your settings'
 * module sections): from GET /facets and the player's `installed`, each
 * null while it loads.
 */
import { youModules, type YouModules } from '../pages/youSections';
import { useFacets } from './useFacets';
import { useCapabilities } from './usePlayer';

export function useYouModules(): YouModules {
  const facets = useFacets();
  const caps = useCapabilities();
  const enabled = facets.data ? Object.fromEntries(facets.data.modules.filter((m) => !m.builtIn).map((m) => [m.id, m.enabled])) : null;
  return youModules({ enabled, playerInstalled: caps.data ? !!caps.data.player?.installed : null });
}
