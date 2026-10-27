/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'path';

/**
 * The build this bundle is, so an open tab can tell when the server runs a
 * newer one (src/services/buildCheck.ts). The Docker build passes the same
 * GIT_SHA and TAGAVE_BUILD_VERSION build args the server reports at /api/v1/version.
 * Without a sha (vite dev, a plain local build) the bundle says "dev", which
 * never counts as out of date.
 */
function bundleBuild(command: 'build' | 'serve'): { sha: string; version: string | null } {
  const sha = (process.env.GIT_SHA ?? '').trim();
  let rootVersion: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version?: string };
    rootVersion = pkg.version ?? null;
  } catch {
    /* no root manifest: no version */
  }
  return {
    sha: command === 'build' && sha && sha !== 'unknown' && sha !== 'dev' ? sha : 'dev',
    version: (process.env.TAGAVE_BUILD_VERSION ?? '').trim() || rootVersion,
  };
}

/**
 * dist/sw.js (the service worker, sw/sw.js) with the build's version and the
 * files the first screen needs: the entry script, the chunks it imports and
 * their CSS. The version hashes every output file's name (content-hashed)
 * and index.html, so a build that changes anything is a new worker.
 */
export function serviceWorkerPlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'tagave-service-worker',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    writeBundle(_options, bundle) {
      const precache = new Set<string>();
      const visit = (fileName: string) => {
        const out = bundle[fileName];
        if (!out || out.type !== 'chunk' || precache.has(`/${fileName}`)) return;
        precache.add(`/${fileName}`);
        for (const css of out.viteMetadata?.importedCss ?? []) precache.add(`/${css}`);
        out.imports.forEach(visit);
      };
      for (const out of Object.values(bundle)) if (out.type === 'chunk' && out.isEntry) visit(out.fileName);
      const hash = createHash('sha256');
      for (const name of Object.keys(bundle).sort()) hash.update(`${name}\n`);
      const html = bundle['index.html'];
      if (html?.type === 'asset') hash.update(html.source);
      const version = hash.digest('hex').slice(0, 16);
      const body = readFileSync(resolve(import.meta.dirname, 'sw/sw.js'), 'utf8');
      const head = `const SW_VERSION = ${JSON.stringify(version)};\nconst SW_PRECACHE = ${JSON.stringify([...precache].sort())};\n`;
      writeFileSync(resolve(outDir, 'sw.js'), head + body);
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), serviceWorkerPlugin()],
  define: {
    __TAGAVE_BUILD__: JSON.stringify(bundleBuild(command)),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/images': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  // Material Color Utilities' ESM imports a few paths without an extension:
  // Vite resolves them, Node's loader does not, so Vitest bundles it in
  test: {
    server: { deps: { inline: ['@material/material-color-utilities'] } },
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
}));
