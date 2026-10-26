/**
 * QA 2026-10-26 Q-07: the sign-in page offered "Create owner account" on
 * an install that already has its owner.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupLink } from './LoginPage';

describe('SetupLink', () => {
  it('is hidden once the owner exists', () => {
    expect(renderToStaticMarkup(<SetupLink setupRequired={false} />)).toBe('');
  });

  it('is hidden while the server has not said (loading, or an error)', () => {
    expect(renderToStaticMarkup(<SetupLink setupRequired={undefined} />)).toBe('');
  });

  it('shows on a fresh install', () => {
    expect(renderToStaticMarkup(<SetupLink setupRequired />)).toContain('Create owner account');
  });
});
