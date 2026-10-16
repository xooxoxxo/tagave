# Vendored: music-connections

- Source: review-gatherer repository, packages/music-connections
- Source commit: 09a3e47734eeb859c0ba5f5ee1f34791dd4ea811
- Vendored on: 2026-10-16
- License: MIT (see `license` in package.json)
- Copied: `src/`, `test/`, `README.md`, `tsconfig.json`, `vitest.config.ts`, `package.json`
- Not copied: `node_modules/`

Replace with the npm package once published.

## Deviations from the source

`src/` and `test/` are byte-identical to the source. No zod 4 or TypeScript 7 source changes were needed.

package.json (dependency ranges aligned to the versions the other Tagave packages already use, so no new versions are installed):

- `dependencies.zod`: `^3.25.0` -> `^4.6.5`
- `devDependencies.typescript`: `^5.6.0` -> `^7.0.2`
- `devDependencies.vitest`: `^2.1.0` -> `^5.0.3`
- `devDependencies.@types/node`: added `^24.19.2` (same as @tagave/core); needed because the TS 7 default lib set no longer provides `URL`/`fetch`/`Response`/`Buffer` globals.

tsconfig.json:

- `compilerOptions.types`: added `["node"]` (same as @tagave/core), for the reason above.
