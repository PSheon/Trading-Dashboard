import { assertLiveExecutionReady, type LiveExecutionGate, type LiveExecutionLease } from "./live-execution-gate.js";
import type { PrivyClient } from "@privy-io/node";
import { createL1ActionHash, type AbstractViemLocalAccount } from "@nktkas/hyperliquid/signing";
import { type LiveExecutionRecord } from "./live-execution.js";
import { type LiveOrderIntent } from "./live-order.js";
import { LiveBoundaryError, WalletAuthorizationService, address, assertSameAuthorization } from "./wallet-authorization.js";

type PrivySignInput = Parameters<ReturnType<ReturnType<PrivyClient["wallets"]>["ethereum"]>["signTypedData"]>[1];
export type PrivySigningAuthorization = Pick<PrivySignInput, "authorization_context">;
const domainFields = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }];
const agentFields = [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }];

/** A single prepared order's signer. It cannot sign transfers, arbitrary typed data,
 * a different network, or an action hash other than the durable prepared order. */
export class PrivyOrderSigner {
  constructor(private readonly client: Pick<PrivyClient, "wallets">, private readonly authorizations: WalletAuthorizationService,
    private readonly signingAuthorization: () => Promise<PrivySigningAuthorization>, private readonly gate: LiveExecutionGate, private readonly now = Date.now) {}

  wallet(record: LiveExecutionRecord, intent: LiveOrderIntent, lease: LiveExecutionLease): AbstractViemLocalAccount {
    const expectedHash = createL1ActionHash({ action: { ...record.action }, nonce: record.nonce, expiresAfter: record.expiresAfter });
    return {
      address: record.authorization.signerAddress,
      signTypedData: async (data) => {
        if (data.domain.name !== "Exchange" || data.domain.version !== "1" || data.domain.chainId !== 1337 ||
            data.domain.verifyingContract !== "0x0000000000000000000000000000000000000000" || data.primaryType !== "Agent" ||
            data.message.source !== (record.authorization.network === "testnet" ? "b" : "a") || data.message.connectionId !== expectedHash ||
            Object.keys(data.message).sort().join(",") !== "connectionId,source" || Object.keys(data.types).sort().join(",") !== "Agent,EIP712Domain" ||
            JSON.stringify(data.types.Agent) !== JSON.stringify(agentFields) || JSON.stringify(data.types.EIP712Domain) !== JSON.stringify(domainFields)) {
          throw new LiveBoundaryError("signer_payload_outside_order_scope");
        }
        const grant = await this.authorizations.authorize(intent);
        assertSameAuthorization(record.authorization, grant);
        const wallet = await this.client.wallets().get(grant.walletId);
        if (wallet.id !== grant.walletId || wallet.chain_type !== "ethereum" || address(wallet.address) !== grant.signerAddress ||
            wallet.owner_id !== grant.privyOwnerId || wallet.archived_at != null) throw new LiveBoundaryError("privy_wallet_identity_mismatch");
        if (record.expiresAfter <= this.now()) throw new LiveBoundaryError("signing_order_expired");
        const authorization = await this.signingAuthorization();
        // Recheck after remote identity/authorization reads; never trust the initial snapshot.
        const fresh = await this.authorizations.authorize(intent);
        assertSameAuthorization(grant, fresh);
        await assertLiveExecutionReady(this.gate, lease, "sign", intent, record);
        if (record.expiresAfter <= this.now()) throw new LiveBoundaryError("signing_order_expired");
        const response = await this.client.wallets().ethereum().signTypedData(grant.walletId, {
          ...authorization, request_expiry: record.expiresAfter, address: grant.signerAddress,
          params: { typed_data: { domain: data.domain, types: { EIP712Domain: domainFields, Agent: agentFields },
            primary_type: "Agent", message: { source: data.message.source, connectionId: data.message.connectionId } } },
        });
        if (response.encoding !== "hex" || !/^0x[0-9a-fA-F]{130}$/.test(response.signature)) throw new LiveBoundaryError("invalid_privy_signature");
        return response.signature as `0x${string}`;
      },
    };
  }
}
