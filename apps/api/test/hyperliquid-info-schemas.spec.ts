import { describe, expect, it, vi } from 'vitest';
import { validateInfoResponse } from '../src/hyperliquid/response-validation.js';
import { extraAgentsSchema, USER_ABSTRACTIONS, userAbstractionSchema } from '../src/hyperliquid/info-schemas.js';
import { PrivyAccountModeClient, type AccountModeIntent } from '../src/copy/live/privy-account-mode-client.js';
import { HyperliquidAgentApprovalVerifier } from '../src/copy/live/hyperliquid-agent-approval.js';
import { PrivyAgentApprovalClient } from '../src/copy/copy-agent-exchange.client.js';
import type { AgentConsentIntent } from '../src/copy/copy-agent-consent.js';
import type { WalletAuthorization } from '../src/copy/live/wallet-authorization.js';

const time = 1_800_000_000_000, account = `0x${'11'.repeat(20)}` as const, agent = `0x${'22'.repeat(20)}` as const, other = `0x${'33'.repeat(20)}`;
const answer = (values: Record<string, unknown>) => vi.fn<typeof fetch>(async (_url, init) => Response.json(values[JSON.parse(String(init?.body)).type as string]));
const parses = (outcome: Promise<unknown>, unparsed: string) => outcome.then(() => true, (error: Error) => error.message !== unparsed);

// Every caller parses the same provider answers (they disagreed: a
// "dexAbstraction" account failed the setup's observation as unavailable).
describe('userAbstraction: one schema for every caller', () => {
  const intent: AccountModeIntent = { operationId: 'mode', accountId: 'account', strategyId: 1, network: 'testnet', accountAddress: account, nonce: time, consentExpiresAt: time + 300_000 };
  const observe = (abstraction: unknown) => new PrivyAccountModeClient({}, async () => undefined, answer({ userRole: { role: 'user' }, userAbstraction: abstraction,
    userDexAbstraction: false, spotClearinghouseState: { balances: [], portfolioMarginEnabled: false } }), () => time).observe(intent);
  it.each([...USER_ABSTRACTIONS.map(value => [value, true] as const), ['unknownMode', false], [null, false], [['disabled'], false], [1, false]] as const)('%j parses: %s', async (value, documented) => {
    expect(userAbstractionSchema.safeParse(value).success).toBe(documented);
    expect((() => { try { validateInfoResponse('userAbstraction', value); return true; } catch { return false; } })()).toBe(documented);
    expect(await parses(observe(value), 'account_mode_observation_unavailable')).toBe(documented);
  });
  // Parsing is not accepting: which mode a copy may run in is unchanged.
  it.each([['disabled', 'confirmed', null], ['default', 'unproven', 'account_mode_standard_unproven'], ['dexAbstraction', 'unproven', 'account_mode_standard_unproven'],
    ['unifiedAccount', 'unsupported', 'account_mode_unsupported_abstraction'], ['portfolioMargin', 'unsupported', 'account_mode_unsupported_abstraction']] as const)('the setup still judges %s %s', async (value, status, issue) => {
    expect(await observe(value)).toMatchObject({ abstraction: value, status, issue });
  });
});

describe('extraAgents: one schema for every caller', () => {
  const grant = { id: 'grant', version: 1, userId: 1, strategyId: 1, walletId: 'wallet', privyOwnerId: 'quorum', signerAddress: agent, accountAddress: account,
    network: 'testnet', scopes: ['copy:trade'], validFrom: 0, expiresAt: time + 100_000, revokedAt: null, exchangeApprovedAt: 0 } as unknown as WalletAuthorization;
  const consent: AgentConsentIntent = { id: 'operation', strategyId: 1, network: 'testnet', accountAddress: account, agentAddress: agent, policyId: 'policy',
    workerQuorumId: 'worker', nonce: time, expiresAt: time + 86_400_000, consentExpiresAt: time + 300_000 };
  // Another agent of the account: whatever it says, neither caller accepts it as ours.
  const listing = (validUntil: unknown, address: unknown = other) => [{ address, name: 'other', validUntil }];
  it.each([[[], true], [listing(null), true], [listing(0), true], [listing(time + 1), true],
    [listing(-1), false], [listing(1.5), false], [listing('soon'), false], [listing(time, 'nope'), false], ['none', false]] as const)('%j parses: %s', async (value, valid) => {
    expect(extraAgentsSchema.safeParse(value).success).toBe(valid);
    const verifier = new HyperliquidAgentApprovalVerifier('testnet', async () => undefined, answer({ extraAgents: value }), () => time);
    expect(await parses(verifier.verify(grant), 'exchange_approval_unavailable')).toBe(valid);
    const setup = new PrivyAgentApprovalClient({}, async () => undefined, answer({ userRole: { role: 'user' }, extraAgents: value }), () => time);
    expect(await parses(setup.observe(consent), 'agent_approval_evidence_unavailable')).toBe(valid);
  });
  it('acceptance is unchanged: the setup wants our agent with its exact expiry, the order path an unexpired one', async () => {
    const ours = [{ address: agent, name: 'copy1', validUntil: consent.expiresAt }];
    const setup = (list: unknown) => new PrivyAgentApprovalClient({}, async () => undefined, answer({ userRole: { role: 'user' }, extraAgents: list }), () => time).observe(consent);
    await expect(setup(ours)).resolves.toEqual({ checkedAt: time, validUntil: consent.expiresAt });
    await expect(setup([{ ...ours[0], validUntil: null }])).rejects.toThrow('agent_approval_evidence_unavailable');
    const order = (list: unknown) => new HyperliquidAgentApprovalVerifier('testnet', async () => undefined, answer({ extraAgents: list }), () => time).verify(grant);
    await expect(order([{ ...ours[0], validUntil: null }])).resolves.toMatchObject({ expiresAt: null });
    await expect(order([{ ...ours[0], validUntil: 0 }])).rejects.toThrow('exchange_agent_expired');
  });
});
