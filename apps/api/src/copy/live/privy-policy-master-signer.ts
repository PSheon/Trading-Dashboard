import { Logger } from '@nestjs/common';
import { PrivyClient } from '@privy-io/node';
import { verifyTypedData, type TypedDataDefinition } from 'viem';
import { z } from 'zod';
import { masterSignersExact } from './privy-master-policy.js';
import { masterActionBound, masterActionSignable, type MasterAccount, type MasterActionBound, type MasterTypedData } from './master-action.js';
import { LiveBoundaryError } from './wallet-authorization.js';

const domainFields = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
/** A copy account with the automatic return: the worker quorum is its
 * additional signer under the owner's policy. */
export interface PolicyMasterAccount extends MasterAccount { readonly workerQuorumId: string; readonly policyId: string }
export interface WorkerMasterSigner {
  readonly available: boolean;
  sign(account: PolicyMasterAccount, data: MasterTypedData, bound: MasterActionBound, deadline: number): Promise<string>;
}
export const WORKER_MASTER_SIGNER = Symbol('WORKER_MASTER_SIGNER');
const walletSchema = z.object({ id: z.string(), address: z.string(), owner_id: z.string().nullable(), chain_type: z.string(), archived_at: z.unknown().optional(),
  policy_ids: z.array(z.string()).optional().default([]), additional_signers: z.array(z.object({ signer_id: z.string(), override_policy_ids: z.array(z.string()).optional().default([]) })) });

/**
 * Signs one exact Hyperliquid user-signed action as a copy account with the
 * worker's authorization key (no owner session: the automatic return after a
 * stop, the idle withdrawal), the one-click plan's `PrivyPolicyMasterSigner`.
 * Before Privy is asked to sign: the action is one of the allowed types with
 * its exact fields, its values match what the caller bound (testnet chain,
 * the owner's main wallet as the destination), and the wallet's signers are
 * exactly the worker quorum under the account's own policy, with no wallet
 * policy. Privy enforces the same constants with the owner's policy; the
 * signature must recover to the account.
 */
export class PrivyPolicyMasterSigner implements WorkerMasterSigner {
  private readonly client: PrivyClient | null;
  private readonly logger = new Logger('PrivyPolicyMasterSigner');
  constructor(private readonly config: { appId?: string; appSecret?: string; workerQuorumId?: string; authorizationPrivateKey?: string }, client?: PrivyClient, private readonly now = Date.now) {
    this.client = client ?? (config.appId && config.appSecret ? new PrivyClient({ appId: config.appId, appSecret: config.appSecret, timeout: 5_000, maxRetries: 0, logLevel: 'off' }) : null);
  }
  get available() { return Boolean(this.client && this.config.workerQuorumId && this.config.authorizationPrivateKey); }
  async sign(rawAccount: PolicyMasterAccount, rawData: MasterTypedData, bound: MasterActionBound, deadline: number): Promise<string> {
    // Which step refused, for the log: the caller only ever sees one code.
    let step = 'input', mismatch = '';
    try {
      const account = structuredClone(rawAccount), data = structuredClone(rawData), started = this.now();
      const client = this.client, key = this.config.authorizationPrivateKey;
      if (!client || !key || !this.config.workerQuorumId || account.workerQuorumId !== this.config.workerQuorumId || !account.policyId ||
        data.domain.name !== 'HyperliquidSignTransaction' || data.domain.version !== '1' || data.domain.verifyingContract !== `0x${'00'.repeat(20)}` ||
        !masterActionSignable(data) || !masterActionBound(data, bound) || !Number.isSafeInteger(deadline) || started >= deadline) throw new Error();
      step = 'wallet_get';
      const wallet = walletSchema.parse(await client.wallets().get(account.walletId));
      step = 'wallet_identity';
      mismatch = [wallet.id !== account.walletId && 'id', wallet.chain_type !== 'ethereum' && 'chain', wallet.address.toLowerCase() !== account.address.toLowerCase() && 'address',
        wallet.owner_id !== account.ownerQuorumId && 'owner', (wallet.archived_at ?? null) !== null && 'archived', wallet.policy_ids.length > 0 && 'wallet_policy',
        !masterSignersExact(wallet.additional_signers, { workerQuorumId: account.workerQuorumId, policyId: account.policyId }) && 'signers'].filter(Boolean).join(',');
      if (wallet.id !== account.walletId || wallet.chain_type !== 'ethereum' || wallet.address.toLowerCase() !== account.address.toLowerCase() ||
        wallet.owner_id !== account.ownerQuorumId || (wallet.archived_at ?? null) !== null || wallet.policy_ids.length ||
        !masterSignersExact(wallet.additional_signers, { workerQuorumId: account.workerQuorumId, policyId: account.policyId })) throw new Error();
      step = 'deadline';
      if (this.now() >= deadline) throw new Error();
      step = 'sign';
      const result = await client.wallets().ethereum().signTypedData(account.walletId, { address: account.address, authorization_context: { authorization_private_keys: [key] },
        request_expiry: Math.min(deadline, started + 30_000), params: { typed_data: { domain: data.domain, types: { ...data.types, EIP712Domain: domainFields }, primary_type: data.primaryType, message: data.message } } } as never);
      step = 'verify';
      if (result.encoding !== 'hex' || !/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(result.signature) ||
        !await verifyTypedData({ address: account.address as `0x${string}`, ...(data as unknown as TypedDataDefinition), signature: result.signature as `0x${string}` })) throw new Error();
      return result.signature;
    } catch (error) {
      // Never a key or a signature: the step, Privy's status and its message.
      const status = (error as { status?: unknown })?.status;
      this.logger.warn(`worker master action ${rawData?.primaryType ?? 'unknown'} refused at ${step}${mismatch ? ` (${mismatch})` : ''}: ${typeof status === 'number' ? `${status} ` : ''}${error instanceof Error ? `${error.name} ${error.message}`.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>').slice(0, 300) : 'unknown'}`);
      throw new LiveBoundaryError('worker_master_signing_unavailable');
    }
  }
}
