/**
 * Your settings is the person's own (spec §2): everyone has it, so the nav
 * takes no role. A module section shows only while its module is on for
 * them. A plain module, not the lazy page chunk, so Layout and the router
 * can read it.
 */

/** Whether each module with a part of the person's is on; null while unknown. */
export type YouModules = {
  player: boolean | null;
  dj: boolean | null;
  listenElsewhere: boolean | null;
  connections: boolean | null;
};

export type YouSection = {
  value: string;
  label: string;
  /** listed only while this module is on */
  module?: keyof YouModules;
  /** reachable by link, not in the nav */
  unlisted?: boolean;
};

export const YOU_SECTIONS: readonly YouSection[] = [
  { value: 'account', label: 'Account' },
  { value: 'appearance', label: 'Appearance' },
  // Appearance › Theme › Custom, a screen of its own on a phone
  { value: 'custom-theme', label: 'Custom theme', unlisted: true },
  { value: 'listening', label: 'Listening', module: 'player' },
  { value: 'dj', label: 'DJ', module: 'dj' },
  { value: 'listen-elsewhere', label: 'Listen elsewhere', module: 'listenElsewhere' },
  { value: 'connections', label: 'Connections', module: 'connections' },
];

/** The listed sections, a module section only while its module is on. */
export function youNav(modules: YouModules): YouSection[] {
  return YOU_SECTIONS.filter((s) => !s.unlisted && (!s.module || modules[s.module] === true));
}

/**
 * From GET /facets (manifest id → on) and the player's `installed`: the
 * same rule Settings › Modules uses for anyone but the owner
 * (SettingsModulesPage.tsx › moduleRows).
 */
export function youModules(o: { enabled: Record<string, boolean> | null; playerInstalled: boolean | null }): YouModules {
  const { enabled, playerInstalled } = o;
  const on = (id: string) => (enabled ? enabled[id] === true : null);
  return { player: playerInstalled, dj: on('dj'), listenElsewhere: on('listen-links'), connections: on('mc') };
}
