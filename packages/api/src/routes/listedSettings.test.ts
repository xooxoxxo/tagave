/**
 * GET /libraries lists a library's settings without its sealed secrets. The
 * TypeSafe key lives in the autotagger's own table, never in
 * libraries.settings; were one ever to land there, its name (…Key) keeps it
 * out of the list all the same, and only its hint is listed.
 */
import { describe, it, expect } from 'vitest';
import { listedSettings } from './library.js';

describe('listedSettings', () => {
  it('drops every sealed secret, keeps the hints, and lists nothing to a non-owner', () => {
    const settings = {
      contactString: 'me@example.com', discogsToken: 'enc:v1:a', discogsTokenHint: 'abcd', acoustidKey: 'enc:v1:b', acoustidKeyHint: 'efgh',
      playerPassword: 'enc:v1:c', typesafeKey: 'enc:v1:d', typesafeKeyHint: 'ijkl', sealedKey: 'enc:v1:e',
    };
    const listed = listedSettings(settings, true);
    expect(listed).toEqual({ contactString: 'me@example.com', discogsTokenHint: 'abcd', acoustidKeyHint: 'efgh', typesafeKeyHint: 'ijkl' });
    expect(JSON.stringify(listed)).not.toContain('enc:');
    expect(listedSettings(settings, false)).toEqual({});
  });
});
