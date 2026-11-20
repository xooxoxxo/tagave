/**
 * Maintenance in Library care's header (spec §4): one Off/On control, the
 * only one in the app's settings (Shift+M and the album page's wrench stay).
 */
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MaintenanceControlView } from './MaintenanceControl';

const noop = () => undefined;
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('MaintenanceControl', () => {
  it('Off and On, named Maintenance', () => {
    const off = renderToStaticMarkup(createElement(MaintenanceControlView, { on: false, onChange: noop }));
    expect(off).toContain('aria-label="Maintenance"');
    expect(off).toContain('>Off<');
    expect(off).toContain('>On<');
    const checked = (html: string) => [...html.matchAll(/<input[^>]*>/g)].filter((m) => m[0].includes('checked=""')).map((m) => /value="(\w+)"/.exec(m[0])?.[1]);
    expect(checked(off)).toEqual(['off']);
    const on = renderToStaticMarkup(createElement(MaintenanceControlView, { on: true, onChange: noop }));
    expect(checked(on)).toEqual(['on']);
  });

  it("Library care's header holds it", () => {
    expect(source('../pages/WorkPage.tsx')).toMatch(/actions=\{<MaintenanceControl/);
  });
});
