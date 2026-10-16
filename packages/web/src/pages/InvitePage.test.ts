import { describe, expect, it } from 'vitest';
import { validateInvite } from './InvitePage';
import { lastSeenText, signInText } from '../components/users/UsersList';

describe('invite form', () => {
  it('asks a new person for a name and a 12-character password typed twice', () => {
    expect(validateInvite({ purpose: 'invite' }, { name: ' ', password: 'short', confirm: 'short' })).toEqual({ name: 'Enter your name.', password: 'At least 12 characters.' });
    expect(validateInvite({ purpose: 'invite' }, { name: 'Kim', password: 'twelve chars!', confirm: 'twelve chars?' })).toEqual({ confirm: 'The two passwords are not the same.' });
    expect(validateInvite({ purpose: 'invite' }, { name: 'Kim', password: 'twelve chars!', confirm: 'twelve chars!' })).toEqual({});
  });

  it('a set-password link needs no name', () => {
    expect(validateInvite({ purpose: 'reset' }, { name: '', password: 'twelve chars!', confirm: 'twelve chars!' })).toEqual({});
  });
});

describe('Settings › Users wording', () => {
  it('says how someone signs in, in a few words', () => {
    expect(signInText({ twoFactor: false, passkeys: 0 })).toBe('Password only');
    expect(signInText({ twoFactor: true, passkeys: 1 })).toBe('Password, 1 passkey and authenticator app');
    expect(signInText({ twoFactor: false, passkeys: 3 })).toBe('Password, 3 passkeys');
  });

  it('says when they were last here', () => {
    expect(lastSeenText(null)).toBe('Never signed in');
    expect(lastSeenText('2026-10-03T10:00:00Z')).toMatch(/^Last here /);
  });
});
