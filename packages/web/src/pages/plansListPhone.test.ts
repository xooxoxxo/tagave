/**
 * The Tag changes list at phone width: seven table columns squeezed the plan
 * name to one letter per line at 390px. On phones each plan is a stacked
 * block with the name on its own full-width line.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./PlansPage.module.css', import.meta.url), 'utf8');
const tsx = readFileSync(new URL('./PlansPage.tsx', import.meta.url), 'utf8');
const phone = css.slice(css.indexOf('@media (max-width: 640px)'));

describe('Tag changes list on a phone', () => {
  it('stacks each plan: no header row, rows wrap, the name takes a full line', () => {
    expect(phone).toMatch(/\.plansTable thead\s*\{\s*display:\s*none/);
    expect(phone).toMatch(/\.plansTable tr\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap/);
    expect(phone).toMatch(/\.plansTable \.cellName\s*\{[^}]*flex:\s*1 1 100%/);
  });

  it('on wider screens the name column keeps a usable minimum width', () => {
    expect(css).toMatch(/\.cellName\s*\{\s*min-width:\s*14rem/);
  });

  it('the table and the name cell carry the classes the layout hangs on', () => {
    expect(tsx).toContain('<Table className={styles.plansTable}>');
    expect(tsx).toContain('<Td className={styles.cellName}>');
  });
});
