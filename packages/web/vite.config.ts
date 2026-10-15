import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
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

export default defineConfig(({ command }) => ({
  plugins: [react()],
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
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
}));
