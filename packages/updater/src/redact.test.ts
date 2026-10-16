import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

describe('redact', () => {
  it('masks the password of a URL', () => {
    expect(redact('Error: connect to postgres://tagave:s3cr3t-Pw@postgres:5432/tagave failed')).toBe('Error: connect to postgres://tagave:***@postgres:5432/tagave failed');
    expect(redact('DATABASE_URL=postgresql://u:p%40ss@db/x')).toBe('DATABASE_URL=postgresql://u:***@db/x');
  });

  it('masks values after secret-looking names', () => {
    expect(redact('PGPASSWORD=hunter2 psql')).toBe('PGPASSWORD=*** psql');
    expect(redact('password: hunter2, user: x')).toBe('password: ***, user: x');
    expect(redact('APP_SECRET=abc123 TAGAVE_PORT=3100')).toBe('APP_SECRET=*** TAGAVE_PORT=3100');
    expect(redact('{"token":"abc.def","x":1}')).toBe('{"token":"***","x":1}');
    expect(redact('api_key=zzz apikey=yyy DISCOGS_KEY=www passwd=q')).toBe('api_key=*** apikey=*** DISCOGS_KEY=*** passwd=***');
  });

  it('masks Authorization headers and bearer tokens', () => {
    expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.x')).toBe('Authorization: Bearer ***');
    expect(redact('authorization=Basic dXNlcjpwYXNz')).toBe('authorization=Basic ***');
    expect(redact('sent bearer abcdefgh12345678 upstream')).toBe('sent bearer *** upstream');
  });

  it('masks long hex and token runs, but not digests', () => {
    const hex = 'a1'.repeat(32);
    expect(redact(`secret is ${hex} here`)).toBe('secret is *** here');
    const digest = `ghcr.io/xooxoxxo/tagave-app:0.9.0@sha256:${'b2'.repeat(32)}`;
    expect(redact(`$ docker pull ${digest}`)).toBe(`$ docker pull ${digest}`);
    expect(redact('token-ish Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1O end')).toBe('token-ish *** end');
  });

  it('leaves ordinary update lines alone', () => {
    for (const line of [
      'signed manifest of 0.9.1 checks out (key 3f0c9a1e5b7d2c44); pulling every image by its digest for linux/amd64',
      'space: Docker\'s data (/var/lib/docker): 40.0 GB free, needs 6.4 GB (the new images, unpacked ~2.5 GB, a database backup ~300 MB, 20 % margin, 3.0 GB left free)',
      'restored /backups/tagave-2026-10-16T10-00-00Z-pre-migration.pgdump; the changed database is kept as tagave_pre_restore_20261016',
      'app keeps stopping (restarted 3 times, last exit code 1): Error: Cannot find module /app/packages/api/dist/index.js',
    ]) expect(redact(line)).toBe(line);
  });
});
