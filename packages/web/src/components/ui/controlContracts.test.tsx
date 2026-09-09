import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from './Button';
import { TextField } from './FormControl';

describe('shared control contracts', () => {
  it('prevents accidental form submission and repeated loading activation', () => {
    const html = renderToStaticMarkup(<Button loading>Saving changes</Button>);
    expect(html).toContain('type="button"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<Button type="submit">Save changes</Button>)).toContain('type="submit"');
  });
  it('connects the visible label and error while preserving external descriptions', () => {
    const html = renderToStaticMarkup(<TextField id="name" label="Library name" error="Enter a name" hint="Choose a name" aria-describedby="external-help" />);
    expect(html).toContain('for="name"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="external-help name-message"');
    expect(html).toContain('id="name-message"');
    expect(html).toContain('Enter a name');
    expect(html).not.toContain('Choose a name');
  });
});
