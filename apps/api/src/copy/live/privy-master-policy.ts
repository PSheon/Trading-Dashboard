import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PrivyClient } from '@privy-io/node';
import type { PolicyRuleRequestBody } from '@privy-io/node/resources';
import { COPY_MASTER_ACTION_TYPES, WALLET_NETWORKS, type CopyMasterPrimaryType } from '@trading-dashboard/shared/contracts';
import { z } from 'zod';
import { safeErrorText } from '../../runtime/safe-error-text.js';

/**
 * The Privy policy that binds the worker quorum when it signs as a copy
 * account (one-click copy plan §2 "Which steps the worker quorum can sign",
 * §3b). It is attached as the worker's `override_policy_ids` only, never as a
 * wallet-level policy, so the owner's own session signs and exports freely.
 * Owned by the user (`owner: { user_id }`), so Orbie can't widen it later.
 *
 * Rules (all `eth_signTypedData_v4`, Hyperliquid's user-signed domain on
 * testnet: chainId = testnet signatureChainId, verifyingContract zero):
 * 1. UsdSend only to the owner's main wallet (exact lowercase string), on
 *    "Testnet" — the automatic return and the idle withdrawal;
 * 2. UserSetAbstraction to "disabled" for this account only;
 * 3. ApproveAgent for exactly the consented agent and name (one-click setup,
 *    when an agent is bound);
 * 4. ApproveBuilderFee for exactly the consented builder and rate, only when
 *    the fee is above 0 (testnet: 0, so omitted);
 * 5. no key or seed export.
 * Proven on the Stage Dev app 2026-10-05 for 1, 3 and 5 by
 * `scripts/privy-master-policy-proto.mjs` (plan doc, prototype results).
 */
const NETWORK = WALLET_NETWORKS.testnet;
const ZERO = `0x${'00'.repeat(20)}`;
const DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
type Primary = CopyMasterPrimaryType;
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
export interface MasterPolicyBinding {
  /** The owner's main wallet: the only UsdSend destination. */
  readonly ownerMain: string;
  /** The copy account itself (UserSetAbstraction's `user`). */
  readonly account: string;
  readonly agent?: { readonly address: string; readonly name: string } | null;
  readonly builder?: { readonly address: string; readonly maxFeeRate: string } | null;
}

const domain = (): PolicyRuleRequestBody['conditions'] => [
  { field_source: 'ethereum_typed_data_domain', field: 'chainId', operator: 'eq', value: String(Number.parseInt(NETWORK.signatureChainId, 16)) },
  { field_source: 'ethereum_typed_data_domain', field: 'verifyingContract', operator: 'eq', value: ZERO },
];
const field = (primary: Primary, name: string, value: string) => ({ field_source: 'ethereum_typed_data_message' as const, field: name, operator: 'eq' as const, value,
  typed_data: { primary_type: primary, types: { EIP712Domain: DOMAIN, [primary]: COPY_MASTER_ACTION_TYPES[primary].map(f => ({ ...f })) } } });
const allow = (name: string, primary: Primary, values: Record<string, string>): PolicyRuleRequestBody => ({ name, method: 'eth_signTypedData_v4', action: 'ALLOW',
  conditions: [...domain(), field(primary, 'hyperliquidChain', NETWORK.hyperliquidChain), ...Object.entries(values).map(([k, v]) => field(primary, k, v))] as PolicyRuleRequestBody['conditions'] });

export function masterPolicyRules(binding: MasterPolicyBinding): PolicyRuleRequestBody[] {
  const ownerMain = address.parse(binding.ownerMain.toLowerCase()), account = address.parse(binding.account.toLowerCase());
  const rules = [
    allow('Return USDC to the owner main wallet', 'HyperliquidTransaction:UsdSend', { destination: ownerMain }),
    allow('Standard account mode', 'HyperliquidTransaction:UserSetAbstraction', { user: account, abstraction: 'disabled' }),
  ];
  if (binding.agent) rules.push(allow('Approve the consented agent', 'HyperliquidTransaction:ApproveAgent', { agentAddress: address.parse(binding.agent.address.toLowerCase()), agentName: binding.agent.name }));
  if (binding.builder) rules.push(allow('Approve the consented builder fee', 'HyperliquidTransaction:ApproveBuilderFee', { builder: address.parse(binding.builder.address.toLowerCase()), maxFeeRate: binding.builder.maxFeeRate }));
  rules.push({ name: 'Deny key export', method: 'exportPrivateKey', action: 'DENY', conditions: [] }, { name: 'Deny seed export', method: 'exportSeedPhrase', action: 'DENY', conditions: [] });
  return rules;
}

/** JSON object key order is irrelevant; array order is exact (as the agent policy's). */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
export const MASTER_POLICY_NAME = 'Orbie copy account automatic return';
/** Lower-cases the values of conditions whose typed-data field is declared
 * `address` (Privy checksums those); leaves every other value as it is. */
function addressCase(rules: readonly unknown[]): unknown[] {
  return rules.map(rule => {
    const r = rule as { conditions?: { field?: unknown; value?: unknown; typed_data?: { primary_type?: string; types?: Record<string, { name: string; type: string }[]> } }[] };
    if (!Array.isArray(r.conditions)) return rule;
    return { ...r, conditions: r.conditions.map(c => {
      const declared = c.typed_data?.types?.[c.typed_data.primary_type ?? '']?.find(f => f.name === c.field)?.type;
      return declared === 'address' && typeof c.value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c.value) ? { ...c, value: c.value.toLowerCase() } : c;
    }) };
  });
}

export class MasterPolicyConflict extends Error { constructor() { super('master_policy_conflict'); } }
export class MasterPolicyUnavailable extends Error { constructor() { super('master_policy_unavailable'); } }
const policySchema = z.object({ id: z.string().min(1), owner_id: z.string().min(1), name: z.string(), version: z.string(), chain_type: z.string(),
  rules: z.array(z.object({ id: z.string().optional() }).passthrough()) });
const quorumSchema = z.object({ id: z.string(), authorization_threshold: z.number().nullable().optional(), authorization_keys: z.array(z.unknown()), user_ids: z.array(z.string()).nullable().optional(), key_quorum_ids: z.array(z.string()).nullable().optional() });
const walletSchema = z.object({ id: z.string(), address: z.string(), owner_id: z.string().nullable(), policy_ids: z.array(z.string()).optional().default([]),
  additional_signers: z.array(z.object({ signer_id: z.string(), override_policy_ids: z.array(z.string()).optional().default([]) })) });

export interface VerifiedMasterPolicy { readonly id: string; readonly ownerQuorumId: string; readonly fingerprint: string }

export const MASTER_POLICY = Symbol('MASTER_POLICY');
export interface MasterPolicyPort {
  readonly available: boolean;
  create(userId: string, binding: MasterPolicyBinding, attemptKey: string): Promise<{ id: string }>;
  verify(policyId: string, userId: string, binding: MasterPolicyBinding): Promise<VerifiedMasterPolicy>;
  /** The wallet's signers are exactly the worker under the policy (the
   * owner's browser attached them: `useSigners().addSigners`). */
  assertSigner(walletId: string, expected: { address: string; ownerQuorumId: string; workerQuorumId: string; policyId: string }): Promise<void>;
  /** Account deletion: the wallet has no additional signer left (the owner's
   * browser removed them: `useSigners().removeSigners`). */
  assertDetached(walletId: string): Promise<void>;
}
/** Creates and verifies the master policy, and reads a wallet's signers.
 * Holds no user session: only the owner's browser adds or removes signers. */
export class PrivyMasterPolicy implements MasterPolicyPort {
  private readonly client: PrivyClient | null;
  private readonly logger = new Logger('PrivyMasterPolicy');
  constructor(config: { appId?: string; appSecret?: string }, client?: PrivyClient) {
    this.client = client ?? (config.appId && config.appSecret ? new PrivyClient({ appId: config.appId, appSecret: config.appSecret, timeout: 10_000, maxRetries: 0, logLevel: 'off' }) : null);
  }
  get available() { return this.client !== null; }
  private require(): PrivyClient { if (!this.client) throw new MasterPolicyUnavailable(); return this.client; }
  private async call<T>(work: () => PromiseLike<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      // Privy's status and the error's name, never its message or a token.
      this.logger.warn(`master policy call failed: ${safeErrorText(error)}`);
      throw new MasterPolicyUnavailable();
    }
  }

  /** Idempotent per `attemptKey` (Privy keeps the key for 24 h). */
  async create(userId: string, binding: MasterPolicyBinding, attemptKey: string): Promise<{ id: string }> {
    const client = this.require();
    const policy = await this.call(() => client.policies().create({ version: '1.0', name: MASTER_POLICY_NAME, chain_type: 'ethereum', owner: { user_id: userId },
      rules: masterPolicyRules(binding), idempotency_key: attemptKey }));
    return { id: z.string().min(1).parse(policy.id) };
  }

  /** The exact rules, owned by exactly this user. Privy stores every
   * `address`-typed condition value in checksum case (Stage 2026-10-06), so
   * those compare without case; every other value (the UsdSend destination is
   * a string) must match exactly as written. */
  async verify(policyId: string, userId: string, binding: MasterPolicyBinding): Promise<VerifiedMasterPolicy> {
    const client = this.require();
    const parsed = policySchema.safeParse(await this.call(() => client.policies().get(policyId)));
    if (!parsed.success) throw new MasterPolicyConflict();
    const policy = parsed.data, rules = policy.rules.map(({ id: _id, ...rule }) => rule);
    if (policy.id !== policyId || policy.name !== MASTER_POLICY_NAME || policy.chain_type !== 'ethereum' ||
      canonical(addressCase(rules)) !== canonical(addressCase(masterPolicyRules(binding)))) throw new MasterPolicyConflict();
    const quorum = quorumSchema.safeParse(await this.call(() => client.keyQuorums().get(policy.owner_id)));
    if (!quorum.success || quorum.data.id !== policy.owner_id || quorum.data.authorization_threshold !== 1 || quorum.data.authorization_keys.length !== 0 ||
      quorum.data.user_ids?.length !== 1 || quorum.data.user_ids[0] !== userId || quorum.data.key_quorum_ids?.length) throw new MasterPolicyConflict();
    const fingerprint = createHash('sha256').update(canonical({ id: policy.id, ownerQuorumId: policy.owner_id, name: policy.name, version: policy.version, chain_type: policy.chain_type, rules })).digest('hex');
    return { id: policy.id, ownerQuorumId: policy.owner_id, fingerprint };
  }

  async assertDetached(walletId: string): Promise<void> {
    const client = this.require();
    const parsed = walletSchema.safeParse(await this.call(() => client.wallets().get(walletId)));
    if (!parsed.success || parsed.data.id !== walletId || parsed.data.additional_signers.length) throw new MasterPolicyConflict();
  }

  /** The wallet's signers are exactly the worker quorum under this policy,
   * and it carries no wallet-level policy. */
  async assertSigner(walletId: string, expected: { address: string; ownerQuorumId: string; workerQuorumId: string; policyId: string }): Promise<void> {
    const client = this.require();
    const parsed = walletSchema.safeParse(await this.call(() => client.wallets().get(walletId)));
    if (!parsed.success) throw new MasterPolicyConflict();
    const wallet = parsed.data;
    if (wallet.id !== walletId || wallet.address.toLowerCase() !== expected.address.toLowerCase() || wallet.owner_id !== expected.ownerQuorumId || wallet.policy_ids.length ||
      !masterSignersExact(wallet.additional_signers, expected)) throw new MasterPolicyConflict();
  }
}

export function masterSignersExact(signers: readonly { signer_id: string; override_policy_ids?: readonly string[] }[], expected: { workerQuorumId: string; policyId: string }): boolean {
  return signers.length === 1 && signers[0]!.signer_id === expected.workerQuorumId && JSON.stringify(signers[0]!.override_policy_ids ?? []) === JSON.stringify([expected.policyId]);
}
