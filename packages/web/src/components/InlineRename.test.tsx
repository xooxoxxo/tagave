/**
 * The inline name editor: what counts as a valid name (same rules as the
 * API) and what it shows at rest.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineRename, nameProblem, normaliseName } from './InlineRename';

describe('normaliseName / nameProblem', () => {
  it('collapses whitespace and trims', () => {
    expect(normaliseName('  Peter   Morén \n tidy-up ')).toBe('Peter Morén tidy-up');
  });

  it('refuses blank and overlong names', () => {
    expect(nameProblem('   ')).toBe('The name cannot be empty');
    expect(nameProblem('x'.repeat(256))).toMatch(/at most 255/);
    expect(nameProblem(` ${'x'.repeat(255)} `)).toBeNull();
    expect(nameProblem('Jazz cleanup')).toBeNull();
  });
});

describe('InlineRename at rest', () => {
  it('shows the name and a labelled pencil button, no field', () => {
    const html = renderToStaticMarkup(<InlineRename value="Set values: The Last Tycoon" label="Rename plan" onSave={async () => undefined} />);
    expect(html).toContain('Set values: The Last Tycoon');
    expect(html).toContain('aria-label="Rename plan"');
    expect(html).not.toContain('<input');
  });
});
