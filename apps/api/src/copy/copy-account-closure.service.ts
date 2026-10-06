import { Inject, Injectable, Optional } from "@nestjs/common";

import { CopySignerAttached, type CopyAccountClosurePort } from "../users/account-closure.port.js";
import { CopyFundingExchangeClient } from "./copy-funding-exchange.client.js";
import { MASTER_POLICY, MasterPolicyConflict, MasterPolicyUnavailable, type MasterPolicyPort } from "./live/privy-master-policy.js";

/** Account deletion's reads of the exchange and of Privy's signers
 * (users/account-closure.port.ts). Moves no funds and signs nothing. */
@Injectable()
export class CopyAccountClosureService implements CopyAccountClosurePort {
  constructor(private readonly exchange: CopyFundingExchangeClient,
    @Optional() @Inject(MASTER_POLICY) private readonly masterPolicy: MasterPolicyPort | null = null) {}

  async isEmpty(network: "testnet" | "mainnet", address: string): Promise<boolean> {
    return (await this.exchange.holdings(network, address)).empty;
  }

  async assertSignerDetached(walletId: string): Promise<void> {
    if (!this.masterPolicy?.available) throw new MasterPolicyUnavailable();
    try { await this.masterPolicy.assertDetached(walletId); }
    catch (error) { throw error instanceof MasterPolicyConflict ? new CopySignerAttached() : error; }
  }
}
