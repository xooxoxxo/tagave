import type { Decorator, Preview } from '@storybook/react-vite';
import { withThemeByDataAttribute } from '@storybook/addon-themes';
import { useState } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
// The app's fonts, tokens and baseline styles, in the order main.tsx loads them.
import '@fontsource/urbanist/200.css';
import '@fontsource/urbanist/300.css';
import '@fontsource/urbanist/400.css';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '../src/styles/index.css';
import './preview.css';
import { ConfirmHost } from '../src/components/ui/ConfirmDialog';
import { ToastHost } from '../src/components/ui/Toast';

/** LinkButton and TableRow need a router: each story renders as the root route of a memory router. */
const withRouter: Decorator = (Story, context) => {
  const [router] = useState(() => {
    const holder: { render: () => React.ReactNode } = { render: () => null };
    const r = createRouter({ routeTree: createRootRoute({ component: () => <>{holder.render()}</> }), history: createMemoryHistory({ initialEntries: ['/'] }) });
    return { r, holder };
  });
  router.holder.render = () => <Story {...context} />;
  return <RouterProvider router={router.r} />;
};

/** The dialog and toast hosts are mounted once at the app root; stories get them too. */
const withHosts: Decorator = (Story) => <><Story /><ConfirmHost /><ToastHost /></>;

/** dir="auto" / "rtl" from the toolbar, for labels in right-to-left scripts. */
const withDirection: Decorator = (Story, context) => {
  const dir = context.globals['dir'] === 'rtl' ? 'rtl' : 'ltr';
  document.documentElement.setAttribute('dir', dir);
  return <Story />;
};

const preview: Preview = {
  decorators: [
    withHosts,
    withDirection,
    withRouter,
    // the app's own mechanism: data-theme on <html> (theme.ts, tokens.css)
    withThemeByDataAttribute({ themes: { light: 'light', dark: 'dark' }, defaultTheme: 'light', attributeName: 'data-theme' }),
  ],
  globalTypes: {
    dir: {
      description: 'Text direction',
      toolbar: { title: 'Direction', icon: 'transfer', items: [{ value: 'ltr', title: 'Left to right' }, { value: 'rtl', title: 'Right to left' }], dynamicTitle: true },
    },
    size: {
      description: 'Control size, for components that have one (Button, IconButton, SegmentedControl, fields)',
      toolbar: { title: 'Size', icon: 'component', items: [{ value: 'md', title: 'Regular' }, { value: 'sm', title: 'Small / dense' }], dynamicTitle: true },
    },
  },
  initialGlobals: { dir: 'ltr', size: 'md' },
  parameters: {
    layout: 'padded',
    controls: { expanded: true, sort: 'requiredFirst' },
    backgrounds: { disable: true },
    viewport: {
      options: {
        phone: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' }, type: 'desktop' },
      },
    },
    a11y: { test: 'error' },
    options: { storySort: { order: ['Foundations', ['Overview', 'Colour', 'Type', 'Space and radii', 'Elevation', 'Motion', 'Buttons and keys'], 'Components'] } },
  },
  tags: ['autodocs'],
};

export default preview;
