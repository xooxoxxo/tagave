import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SystemCheckList } from './SystemCheckList';

describe('SystemCheckList', () => {
  it('shows a command in backticks as code, not with the backticks (QA Q-38)', () => {
    const html = renderToStaticMarkup(<SystemCheckList checks={[{ id: 'disk', title: 'disk', status: 'warn', remediation: 'Run `df -h` to see what fills it.' }]} />);
    expect(html).toContain('Run <code>df -h</code> to see what fills it.');
    expect(html).not.toContain('`');
  });

  it('names the disk check plainly', () => {
    const html = renderToStaticMarkup(<SystemCheckList checks={[{ id: 'disk', title: 'disk', status: 'warn' }]} />);
    expect(html).toContain('Disk space');
  });
});
