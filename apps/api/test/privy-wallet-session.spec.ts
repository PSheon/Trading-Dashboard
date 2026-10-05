import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { privyJwtKind, privyWalletJwt } from '../src/common/auth/privy-wallet-session.js';

const jwt = (payload: Record<string, unknown>) => `eyJhbGciOiJFUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const user = { kind: 'user' as const, id: 7, privyUserId: 'did:privy:owner', role: 'user' as const };
const now = 1_800_000_000_000, exp = now / 1000 + 600;
const identity = jwt({ sub: 'did:privy:owner', exp, linked_accounts: '[]' }), access = jwt({ sub: 'did:privy:owner', exp, sid: 's' });

// Stage 2026-10-05: Privy's wallet session exchange answered the access
// token with 400 "Invalid JWT token provided"; it takes the identity token.
describe('the JWT handed to Privy for the user\'s wallets', () => {
  it('is the identity token the browser sent for this same, unexpired user', () => {
    expect(privyWalletJwt(user, `Bearer ${access}`, identity, now)).toBe(identity);
  });
  it.each([
    ['none was sent', undefined],
    ['it belongs to someone else', jwt({ sub: 'did:privy:other', exp, linked_accounts: '[]' })],
    ['it expired', jwt({ sub: 'did:privy:owner', exp: now / 1000 - 1, linked_accounts: '[]' })],
    ['it is not a JWT', 'garbage'],
  ])('falls back to the access token when %s', (_label, sent) => {
    expect(privyWalletJwt(user, `Bearer ${access}`, sent, now)).toBe(access);
  });
  it('still requires the signed-in Authorization', () => {
    expect(() => privyWalletJwt(user, undefined, identity, now)).toThrow(UnauthorizedException);
  });
  it('tells the two token kinds apart for the logs', () => {
    expect([privyJwtKind(identity), privyJwtKind(access), privyJwtKind('x')]).toEqual(['identity', 'access', 'unknown']);
  });
});

describe('the copy endpoints that act on the user\'s wallets', () => {
  it('hand the identity token to the setup driver (confirm and advance)', async () => {
    const { CopyLiveSetupController } = await import('../src/copy/copy-live-setup.controller.js');
    const calls: string[] = [];
    const setups = { confirm: async (_u: number, _id: string, _b: unknown, token: string) => { calls.push(token); }, advance: async (_u: number, _id: string, token: string) => { calls.push(token); } };
    const controller = new CopyLiveSetupController(setups as never);
    const fresh = jwt({ sub: 'did:privy:owner', exp: Date.now() / 1000 + 600, linked_accounts: '[]' });
    await controller.confirm(user, { id: 's' } as never, {} as never, `Bearer ${access}`, fresh);
    await controller.advance(user, { id: 's' } as never, `Bearer ${access}`, fresh);
    expect(calls).toEqual([fresh, fresh]);
  });
});
