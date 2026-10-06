import { isDeepStrictEqual } from 'node:util';
import {
  createL1ActionHash,
  signL1Action,
  type AbstractViemLocalAccount,
} from '@nktkas/hyperliquid/signing';
import { verifyTypedData } from 'viem';
import { BoundaryPrivyOrderSigningClient } from './privy-order-client.js';
import type { PrivySigningAuthorization } from './privy-order-signer.js';
import { boundedLiveRead } from './live-market-resolver.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';
import { PHANTOM_AGENT_SOURCE } from './privy-agent-provisioner.js';
import {
  assertCancellationPermit,
  assertTrackedCancellation,
  synchronousCancellationGuard,
  type CancellationPermit,
  type PreparedTrackedCancellation,
  type TrackedCancellationAuthority,
} from './live-tracked-cancellation.js';

const domain = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: `0x${'00'.repeat(20)}` as `0x${string}`,
};
const agentFields = [
  { name: 'source', type: 'string' },
  { name: 'connectionId', type: 'bytes32' },
];
const domainFields = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];
export function captureCancellationPermit(
  permit: CancellationPermit,
): CancellationPermit {
  const { assertFresh, ...data } = permit;
  return {
    ...structuredClone(data),
    assertFresh: () => assertFresh.call(permit),
  };
}
/** Only this fixed cancellation hash is admitted. The existing fixed-origin
 * low-level Privy Agent RPC adapter is reused, not the order signer/executor. */
export class PrivyTrackedCancellationSigner {
  constructor(
    private readonly client: BoundaryPrivyOrderSigningClient,
    private readonly authority: TrackedCancellationAuthority,
    private readonly signingAuthorization: () => Promise<PrivySigningAuthorization>,
    private readonly now = Date.now,
  ) {
    if (!(client instanceof BoundaryPrivyOrderSigningClient))
      throw new LiveBoundaryError('cancel_rpc_boundary_missing');
  }
  async current(
    operation: PreparedTrackedCancellation,
    phase: 'sign' | 'submit',
  ): Promise<CancellationPermit> {
    const permit = captureCancellationPermit(
      await boundedLiveRead(() => 
        this.authority.authorize(structuredClone(operation), phase),
        5000,
      ),
    );
    assertCancellationPermit(permit, operation, phase, this.now());
    return permit;
  }
  async sign(
    supplied: PreparedTrackedCancellation,
    callerGuard: () => void,
    onSigningRequest: () => void,
  ) {
    const operation = structuredClone(supplied);
    assertTrackedCancellation(operation, this.now());
    const hash = createL1ActionHash({
      action: { ...operation.action },
      nonce: operation.nonce,
      expiresAfter: operation.expiresAfter,
    });
    const authorization = operation.authorization;
    // The phantom agent's source and the SDK's chain follow the grant's
    // network (the deployment's): "a" on mainnet, "b" on testnet.
    if (authorization.network !== 'testnet' && authorization.network !== 'mainnet') throw new LiveBoundaryError('cancel_signer_payload_outside_scope');
    const source = PHANTOM_AGENT_SOURCE[authorization.network];
    let boundaryFailure: LiveBoundaryError | undefined;
    let signature;
    try {
      signature = await signL1Action({
        action: { ...operation.action },
        nonce: operation.nonce,
        expiresAfter: operation.expiresAfter,
        isTestnet: authorization.network === 'testnet',
        wallet: {
          address: authorization.signerAddress,
          signTypedData: async (
            suppliedData: Parameters<
              AbstractViemLocalAccount['signTypedData']
            >[0],
          ) => {
            try {
              const data = structuredClone(suppliedData);
              if (
                !isDeepStrictEqual(data.domain, domain) ||
                data.primaryType !== 'Agent' ||
                !isDeepStrictEqual(data.types, {
                  EIP712Domain: domainFields,
                  Agent: agentFields,
                }) ||
                !isDeepStrictEqual(data.message, {
                  source,
                  connectionId: hash,
                })
              )
                throw new LiveBoundaryError(
                  'cancel_signer_payload_outside_scope',
                );
              // Current permission is independently reloaded before identity and again
              // after all remote reads and SDK authorization preparation.
              await this.current(operation, 'sign');
              const walletCheckedAt = this.now();
              const wallet = await boundedLiveRead(() => 
                this.client.getWallet(authorization.walletId),
                5000,
              );
              if (
                wallet.id !== authorization.walletId ||
                wallet.chain_type !== 'ethereum' ||
                address(wallet.address) !==
                  address(authorization.signerAddress) ||
                wallet.owner_id !== authorization.privyOwnerId ||
                wallet.archived_at !== null
              )
                throw new LiveBoundaryError(
                  'cancel_privy_wallet_identity_mismatch',
                );
              const context = await boundedLiveRead(() => 
                this.signingAuthorization(),
                5000,
              );
              const permit = await this.current(operation, 'sign');
              const guard = () => {
                synchronousCancellationGuard(callerGuard);
                assertCancellationPermit(permit, operation, 'sign', this.now());
                if (
                  this.now() < walletCheckedAt ||
                  this.now() - walletCheckedAt > 5000
                )
                  throw new LiveBoundaryError(
                    'cancel_privy_wallet_identity_stale',
                  );
              };
              guard();
              onSigningRequest();
              const response = await this.client.signTypedData(
                authorization.walletId,
                {
                  ...context,
                  request_expiry: operation.expiresAfter,
                  address: authorization.signerAddress,
                  params: {
                    typed_data: {
                      domain,
                      types: { EIP712Domain: domainFields, Agent: agentFields },
                      primary_type: 'Agent',
                      message: { source, connectionId: hash },
                    },
                  },
                },
                guard,
              );
              if (
                response.encoding !== 'hex' ||
                !/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/.test(response.signature)
              )
                throw new LiveBoundaryError('cancel_privy_signature_invalid');
              let valid = false;
              try {
                valid = await verifyTypedData({
                  address: authorization.signerAddress,
                  domain,
                  types: { Agent: agentFields },
                  primaryType: 'Agent',
                  message: { source, connectionId: hash },
                  signature: response.signature as `0x${string}`,
                });
              } catch {
                /* No signature in errors. */
              }
              if (!valid)
                throw new LiveBoundaryError(
                  'cancel_privy_signature_scope_mismatch',
                );
              // Verification is asynchronous too; it cannot restore expired authority.
              guard();
              return response.signature as `0x${string}`;
            } catch (error) {
              if (error instanceof LiveBoundaryError) boundaryFailure = error;
              throw error;
            }
          },
        },
      });
    } catch {
      // SDK wallet errors wrap their cause. Preserve only our own safe code,
      // never a provider error/string/signature or authorization material.
      throw (
        boundaryFailure ?? new LiveBoundaryError('cancel_signing_ambiguous')
      );
    }
    return {
      action: operation.action,
      nonce: operation.nonce,
      expiresAfter: operation.expiresAfter,
      signature,
    };
  }
}
