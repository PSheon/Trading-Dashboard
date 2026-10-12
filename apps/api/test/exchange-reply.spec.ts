import { describe, expect, it } from 'vitest';
import { classifyUsdSendReply, type UsdSendReplyOutcome } from '../src/hyperliquid/exchange-reply.js';

/** The checks as they stood inline, verbatim. `return` is copy-live-return
 * settle (migrated), copy-live-setup-abort refund and the auto-return sweep;
 * the others keep their own checks and are here to pin how they differ. */
const old = {
  return(reply: unknown): UsdSendReplyOutcome {
    if (reply && typeof reply === 'object' && 'status' in reply && 'response' in reply) {
      if (reply.status === 'ok' && reply.response && typeof reply.response === 'object' && 'type' in reply.response && reply.response.type === 'default') return 'accepted';
      if (reply.status === 'err' && typeof reply.response === 'string' && reply.response && !/nonce/i.test(reply.response)) return 'rejected';
    }
    return 'unknown';
  },
  funding(reply: unknown): UsdSendReplyOutcome {
    if (reply && typeof reply === "object" && Object.keys(reply).sort().join(",") === "response,status" && "status" in reply && "response" in reply) {
      if (reply.status === "ok" && reply.response && typeof reply.response === "object" && Object.keys(reply.response).join(",") === "type" && "type" in reply.response && reply.response.type === "default") return 'accepted';
      if (reply.status === "err" && typeof reply.response === "string" && reply.response && !/nonce/i.test(reply.response)) return 'rejected';
    }
    return 'unknown';
  },
  withdrawal(reply: unknown): UsdSendReplyOutcome {
    if (reply && typeof reply === "object" && Object.keys(reply).length === 2 && "status" in reply && "response" in reply) {
      if (reply.status === "ok" && reply.response && typeof reply.response === "object" && "type" in reply.response && reply.response.type === "default" && Object.keys(reply.response).length === 1) return 'accepted';
      if (reply.status === "err" && typeof reply.response === "string" && reply.response.length > 0 && !/nonce/i.test(reply.response)) return 'rejected';
    }
    return 'unknown';
  },
  accountMode(response: unknown): UsdSendReplyOutcome {
    if (response && typeof response === 'object' && 'status' in response && 'response' in response &&
        (response.status === 'ok' && response.response && typeof response.response === 'object' && 'type' in response.response && response.response.type === 'default' || response.status === 'err' && typeof response.response === 'string' && !/nonce/i.test(response.response)))
      return response.status === 'ok' ? 'accepted' : 'rejected';
    return 'unknown';
  },
};
const fixtures: [string, unknown, UsdSendReplyOutcome][] = [
  ['accepted', { status: 'ok', response: { type: 'default' } }, 'accepted'],
  ['accepted with extra response data', { status: 'ok', response: { type: 'default', data: {} } }, 'accepted'],
  ['accepted with an extra top-level key', { status: 'ok', response: { type: 'default' }, extra: 1 }, 'accepted'],
  ['insufficient balance', { status: 'err', response: 'Insufficient balance for token transfer' }, 'rejected'],
  ['must deposit', { status: 'err', response: 'Must deposit before performing actions. User: 0x0000000000000000000000000000000000000001' }, 'rejected'],
  ['unknown signer', { status: 'err', response: 'User or API Wallet 0x0000000000000000000000000000000000000002 does not exist.' }, 'rejected'],
  ['rejected with an extra top-level key', { status: 'err', response: 'Insufficient balance', extra: 1 }, 'rejected'],
  ['nonce already used', { status: 'err', response: 'Invalid nonce: duplicate nonce' }, 'unknown'],
  ['nonce too old', { status: 'err', response: 'Nonce 1760000000000 too low' }, 'unknown'],
  ['empty reason', { status: 'err', response: '' }, 'unknown'],
  ['err with an object', { status: 'err', response: { error: 'x' } }, 'unknown'],
  ['ok with an order response', { status: 'ok', response: { type: 'order', data: { statuses: [] } } }, 'unknown'],
  ['ok with a string', { status: 'ok', response: 'default' }, 'unknown'],
  ['ok with null', { status: 'ok', response: null }, 'unknown'],
  ['ok without response', { status: 'ok' }, 'unknown'],
  ['other status', { status: 'unknownStatus', response: 'x' }, 'unknown'],
  ['html error page', '<html>502 Bad Gateway</html>', 'unknown'],
  ['null', null, 'unknown'],
  ['undefined', undefined, 'unknown'],
  ['array', [{ status: 'ok', response: { type: 'default' } }], 'unknown'],
  ['number', 0, 'unknown'],
];
describe.each(fixtures)('%s', (_name, reply, expected) => {
  it('classifies as the migrated caller did', () => {
    expect(old.return(reply)).toBe(expected);
    expect(classifyUsdSendReply(reply)).toBe(expected);
  });
});
it('pins where the unmigrated callers differ', () => {
  const differ = (check: (reply: unknown) => UsdSendReplyOutcome) =>
    fixtures.filter(([, reply]) => check(reply) !== classifyUsdSendReply(reply)).map(([name, reply]) => [name, check(reply)]);
  expect(differ(old.funding)).toEqual([['accepted with extra response data', 'unknown'], ['accepted with an extra top-level key', 'unknown'], ['rejected with an extra top-level key', 'unknown']]);
  expect(differ(old.withdrawal)).toEqual(differ(old.funding));
  expect(differ(old.accountMode)).toEqual([['empty reason', 'rejected']]);
});
