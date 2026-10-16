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

## Build to dist (so the dist-built api and worker can import it)

The source package exported raw TypeScript (`./src/index.ts`), which `node packages/{api,worker}/dist/index.js` cannot load (`.js` specifiers are not rewritten, parameter properties are not strippable). Changed to match @tagave/core:

- package.json: `main` `./src/index.ts` -> `./dist/index.js`; added `types` `./dist/index.d.ts`; `exports` `"."` `./src/index.ts` -> `{ types: ./dist/index.d.ts, default: ./dist/index.js }`; added `"files": ["dist"]`; added script `"build": "tsc -b"`; `typecheck` `tsc --noEmit` -> `tsc --noEmit -p tsconfig.test.json`.
- tsconfig.json: `outDir` `./dist` -> `dist`; `rootDir` `.` -> `src`; `include` `["src","test"]` -> `["src"]` (composite comes from tsconfig.base.json).
- tsconfig.test.json: new; extends tsconfig.json with `composite/declaration/declarationMap` off, `rootDir` `.`, `include` `["src","test"]`, used only by `typecheck` so tests are still type-checked.
- vitest.config.ts unchanged (tests are in test/, not emitted to dist).
