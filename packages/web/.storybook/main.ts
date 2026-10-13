import type { StorybookConfig } from '@storybook/react-vite';

/**
 * The component library: every shared primitive in components/ui, plus the
 * foundations (tokens, type, motion). It builds with the app's own Vite
 * config (vite.config.ts), so CSS modules, the @ alias and the fonts resolve
 * exactly as they do in the app.
 */
const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../src/stories/**/*.mdx', '../src/stories/**/*.stories.tsx', '../src/components/ui/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y', '@storybook/addon-themes', 'storybook-addon-pseudo-states'],
  core: { disableTelemetry: true },
  // react-docgen parses the source with Babel: TypeScript 7 has no JS
  // compiler API for react-docgen-typescript to use
  typescript: { reactDocgen: 'react-docgen' },
  // the app's dev proxy and build output make no sense here
  viteFinal: (vite) => ({ ...vite, server: { ...vite.server, proxy: {} }, build: { ...vite.build, sourcemap: false } }),
};

export default config;
