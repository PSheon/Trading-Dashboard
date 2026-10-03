import { assertLiveExecutionReady, assertLiveExecutionPermit, type LiveExecutionGate, type LiveExecutionLease } from "./live-execution-gate.js";
import type { PrivyClient } from "@privy-io/node";
import { createL1ActionHash, type AbstractViemLocalAccount } from "@nktkas/hyperliquid/signing";
import { type LiveExecutionRecord } from "./live-execution.js";
import { type LiveOrderIntent } from "./live-order.js";
import { LiveBoundaryError, WalletAuthorizationService, address, assertSameAuthorization, assertVerifiedAuthorizationFresh, type VerifiedWalletAuthorization } from "./wallet-authorization.js";
import { isDeepStrictEqual } from 'node:util';
import { verifyTypedData } from 'viem';
import { marketIdentityKey, type LiveMarketIdentity } from './live-market-resolver.js';
import type { LiveNetwork } from './wallet-authorization.js';

export type PrivyOrderSignInput = Parameters<ReturnType<ReturnType<PrivyClient["wallets"]>["ethereum"]>["signTypedData"]>[1];
export type PrivySigningAuthorization = Pick<PrivyOrderSignInput, "authorization_context">;
export interface PrivyOrderSigningClient {
  getWallet(walletId: string): Promise<{ id: string; chain_type: string; address: string; owner_id: string | null; archived_at?: number | null }>;
  /** The implementation must invoke this synchronous guard at the actual RPC
   * fetch boundary, after all SDK authorization/request preparation awaits. */
  signTypedData(walletId: string, input: PrivyOrderSignInput, assertFresh: () => void): Promise<{ encoding: string; signature: string }>;
}
export interface LiveBuilderApprovalProof {
  network: LiveNetwork; accountAddress: string; builderAddress: string;
  feeTenthsBps: number; approvedMaxFeeTenthsBps: number; checkedAt: number;
}
export interface LiveSigningBoundaryProof { market?: LiveMarketIdentity; builder?: LiveBuilderApprovalProof; }
export type LiveSigningBoundaryVerifier = (record: LiveExecutionRecord, intent: LiveOrderIntent) => Promise<LiveSigningBoundaryProof>;

/** Pure proof checks after the final lease; no await may follow before sign/POST. */
export function assertLiveSigningBoundaryProof(proof: LiveSigningBoundaryProof, record: LiveExecutionRecord,
  intent: LiveOrderIntent, now: number): void {
  const fresh = (at: number) => Number.isSafeInteger(at) && at <= now && now - at <= 5_000;
  if (intent.market && (!proof.market || !fresh(proof.market.observedAt) ||
      !isDeepStrictEqual(marketIdentityKey(intent.market), marketIdentityKey(proof.market))))
    throw new LiveBoundaryError('live_market_proof_invalid');
  const expected = record.action.builder;
  if (expected) {
    const b = proof.builder;
    if (!b || b.network !== record.authorization.network || address(b.accountAddress) !== address(record.authorization.accountAddress) ||
        address(b.builderAddress) !== expected.b || b.feeTenthsBps !== expected.f ||
        !Number.isSafeInteger(b.approvedMaxFeeTenthsBps) || b.approvedMaxFeeTenthsBps < expected.f ||
        b.approvedMaxFeeTenthsBps > 100 || !fresh(b.checkedAt)) throw new LiveBoundaryError('builder_approval_proof_invalid');
  }
}
const domainFields = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }];
const agentFields = [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }];

/** A single prepared order's signer. It cannot sign transfers, arbitrary typed data,
 * a different network, or an action hash other than the durable prepared order. */
export class PrivyOrderSigner {
  constructor(private readonly client: PrivyOrderSigningClient, private readonly authorizations: WalletAuthorizationService,
    private readonly signingAuthorization: () => Promise<PrivySigningAuthorization>, private readonly gate: LiveExecutionGate, private readonly now = Date.now,
    private readonly boundaryVerifier?: LiveSigningBoundaryVerifier) {}

  async assertAuthorization(record: LiveExecutionRecord, intent: LiveOrderIntent): Promise<VerifiedWalletAuthorization> {
    const verified = await this.authorizations.authorizeWithEvidence(intent);
    assertSameAuthorization(record.authorization, verified.grant);
    return verified;
  }

  assertAuthorizationFresh(verified: VerifiedWalletAuthorization, intent: LiveOrderIntent): void {
    assertVerifiedAuthorizationFresh(verified, intent, this.now());
  }

  wallet(record: LiveExecutionRecord, intent: LiveOrderIntent, lease: LiveExecutionLease,
    boundaryVerifier = this.boundaryVerifier): AbstractViemLocalAccount {
    record = structuredClone(record);
    intent = structuredClone(intent);
    const expectedHash = createL1ActionHash({ action: { ...record.action }, nonce: record.nonce, expiresAfter: record.expiresAfter });
    return {
      address: record.authorization.signerAddress,
      signTypedData: async (data) => {
        // Detach caller-owned objects synchronously before any provider await.
        // Validation and the eventual SDK request use this same captured payload.
        data = structuredClone(data);
        if (data.domain.name !== "Exchange" || data.domain.version !== "1" || data.domain.chainId !== 1337 ||
            data.domain.verifyingContract !== "0x0000000000000000000000000000000000000000" || data.primaryType !== "Agent" ||
            data.message.source !== (record.authorization.network === "testnet" ? "b" : "a") || data.message.connectionId !== expectedHash ||
            Object.keys(data.message).sort().join(",") !== "connectionId,source" || Object.keys(data.types).sort().join(",") !== "Agent,EIP712Domain" ||
            JSON.stringify(data.types.Agent) !== JSON.stringify(agentFields) || JSON.stringify(data.types.EIP712Domain) !== JSON.stringify(domainFields)) {
          throw new LiveBoundaryError("signer_payload_outside_order_scope");
        }
        const grant = await this.authorizations.authorizeLocal(intent);
        assertSameAuthorization(record.authorization, grant);
        const walletCheckedAt = this.now();
        const wallet = await this.client.getWallet(grant.walletId);
        if (wallet.id !== grant.walletId || wallet.chain_type !== "ethereum" || address(wallet.address) !== grant.signerAddress ||
            wallet.owner_id !== grant.privyOwnerId || wallet.archived_at != null) throw new LiveBoundaryError("privy_wallet_identity_mismatch");
        if (record.expiresAfter <= this.now()) throw new LiveBoundaryError("signing_order_expired");
        const authorization = await this.signingAuthorization();
        // Recheck after remote identity/authorization reads; never trust the initial snapshot.
        const fresh = await this.authorizations.authorizeLocal(intent);
        assertSameAuthorization(grant, fresh);
        const permit = await assertLiveExecutionReady(this.gate, lease, "sign", intent, record);
        const verified = await this.assertAuthorization(record, intent);
        if (record.action.builder && !boundaryVerifier) throw new LiveBoundaryError('builder_approval_verifier_missing');
        const proof = boundaryVerifier ? await boundaryVerifier(structuredClone(record), structuredClone(intent)) : {};
        // The extra proof read may block: re-read consent and exchange approval
        // afterwards, then check proof freshness after the final lease.
        const finalAuthorization = boundaryVerifier ? await this.assertAuthorization(record, intent) : verified;
        await lease.assertHeld();
        assertLiveExecutionPermit(permit, 'sign', intent, record);
        this.assertAuthorizationFresh(finalAuthorization, intent);
        if (boundaryVerifier) assertLiveSigningBoundaryProof(proof, record, intent, this.now());
        if (record.expiresAfter <= this.now()) throw new LiveBoundaryError("signing_order_expired");
        const assertRpcFresh = () => {
          assertLiveExecutionPermit(permit, 'sign', intent, record);
          this.assertAuthorizationFresh(finalAuthorization, intent);
          if (boundaryVerifier) assertLiveSigningBoundaryProof(proof, record, intent, this.now());
          const now = this.now();
          if (!Number.isSafeInteger(walletCheckedAt) || now < walletCheckedAt || now - walletCheckedAt > 5000)
            throw new LiveBoundaryError('privy_wallet_identity_stale');
          if (record.expiresAfter <= now) throw new LiveBoundaryError('signing_order_expired');
        };
        const response = await this.client.signTypedData(grant.walletId, {
          ...authorization, request_expiry: record.expiresAfter, address: grant.signerAddress,
          params: { typed_data: { domain: data.domain, types: { EIP712Domain: domainFields, Agent: agentFields },
            primary_type: "Agent", message: { source: data.message.source, connectionId: data.message.connectionId } } },
        }, assertRpcFresh);
        if (response.encoding !== "hex" || !/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(response.signature)) throw new LiveBoundaryError("invalid_privy_signature");
        let validSignature = false;
        try {
          validSignature = await verifyTypedData({ address: grant.signerAddress,
            domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
            types: { Agent: agentFields }, primaryType: 'Agent',
            message: { source: record.authorization.network === 'testnet' ? 'b' : 'a', connectionId: expectedHash },
            signature: response.signature as `0x${string}` });
        } catch { /* Never expose provider signatures through crypto errors. */ }
        if (!validSignature) throw new LiveBoundaryError('privy_signature_scope_mismatch');
        return response.signature as `0x${string}`;
      },
    };
  }
}
