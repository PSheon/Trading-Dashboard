/**
 * What a Hyperliquid `/exchange` reply to a signed usdSend says about the
 * transfer:
 * - `accepted`: `{ status: 'ok', response: { type: 'default', … } }`;
 * - `rejected`: `{ status: 'err', response: '<non-empty reason>' }` whose
 *   reason does not mention the nonce (a nonce error may mean an earlier copy
 *   of the same action already landed, so it never proves "not sent");
 * - `unknown`: anything else; confirmed from the ledger, never resent.
 * The return, setup-abort refund and auto-return sweep classify this way.
 * Funding and withdrawal also require the exact key sets, account mode takes
 * an empty `err` reason as rejected, and the builder-fee approval is not a
 * usdSend: those keep their own checks.
 */
export type UsdSendReplyOutcome = 'accepted' | 'rejected' | 'unknown';
export function classifyUsdSendReply(reply: unknown): UsdSendReplyOutcome {
  if (!reply || typeof reply !== 'object' || !('status' in reply) || !('response' in reply)) return 'unknown';
  const { status, response } = reply;
  if (status === 'ok' && response && typeof response === 'object' && 'type' in response && response.type === 'default') return 'accepted';
  if (status === 'err' && typeof response === 'string' && response && !/nonce/i.test(response)) return 'rejected';
  return 'unknown';
}
