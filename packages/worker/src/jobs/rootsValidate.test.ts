import { describe, it, expect } from 'vitest';
import { classifyProbe } from './rootsValidate.js';

describe('classifyProbe', () => {
  it('returns ok when no error and is directory', () => {
    const result = classifyProbe(null, true);
    expect(result).toEqual({ status: 'ok' });
  });

  it('returns missing on ENOENT', () => {
    const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const result = classifyProbe(err, null);
    expect(result.status).toBe('missing');
    expect(result.message).toContain('does not exist');
  });

  it('returns not_directory when ENOTDIR', () => {
    const err = new Error('ENOTDIR: not a directory') as NodeJS.ErrnoException;
    err.code = 'ENOTDIR';
    const result = classifyProbe(err, null);
    expect(result.status).toBe('not_directory');
  });

  it('returns unreadable on other errors (EACCES)', () => {
    const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    const result = classifyProbe(err, null);
    expect(result.status).toBe('unreadable');
    expect(result.message).toContain('Cannot read directory');
  });

  it('returns not_directory when isDirectory is false', () => {
    const result = classifyProbe(null, false);
    expect(result.status).toBe('not_directory');
    expect(result.message).toContain('not a directory');
  });

  it('returns unreadable on EIO', () => {
    const err = new Error('EIO: input/output error') as NodeJS.ErrnoException;
    err.code = 'EIO';
    const result = classifyProbe(err, null);
    expect(result.status).toBe('unreadable');
  });
});
