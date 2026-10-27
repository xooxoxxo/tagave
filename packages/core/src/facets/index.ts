/**
 * Facets and the module registry (Facets and Connectors design §3-§8): core
 * owns entity identity, modules add named, versioned facets, and one module
 * reads another's data only through facets.get.
 */
import { createRegistry } from './registry.js';
import { CASTS, FACETS } from './internal.js';
import { APPS, MODULES } from './manifests.js';

export * from './define.js';
export * from './registry.js';
export * from './internal.js';
export * from './manifests.js';

/** tagave's registry: its facets, apps and modules, no casts (v1). */
export const registry = createRegistry({ facets: FACETS, modules: MODULES, apps: APPS, casts: CASTS });
