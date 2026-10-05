import { Module } from "@nestjs/common";

import { AppConfig } from "../config/app-config.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { WALLET_NETWORK_HL, type WalletNetworkHyperliquid } from "../hyperliquid/wallet-network-hyperliquid.js";
import { COPY_ACCOUNT_CLOSURE } from "../users/account-closure.port.js";
import { CopyAccountClosureService } from "./copy-account-closure.service.js";
import { CopyFundingExchangeClient } from "./copy-funding-exchange.client.js";
import { MASTER_POLICY, PrivyMasterPolicy } from "./live/privy-master-policy.js";

/** Account deletion's view of the copy side (users/account-closure.port.ts):
 * the exchange read of a copy account and Privy's signer removal, without
 * the rest of CopyModule. */
@Module({
  imports: [HyperliquidModule],
  providers: [
    // A copy account is on the wallet network (testnet): its budget and egress.
    { provide: CopyFundingExchangeClient, inject: [WALLET_NETWORK_HL],
      useFactory: ({ budget, transport }: WalletNetworkHyperliquid) => new CopyFundingExchangeClient(budget, transport) },
    { provide: MASTER_POLICY, inject: [AppConfig], useFactory: (config: AppConfig) => new PrivyMasterPolicy(config.value.auth) },
    { provide: COPY_ACCOUNT_CLOSURE, useClass: CopyAccountClosureService },
  ],
  exports: [COPY_ACCOUNT_CLOSURE],
})
export class CopyAccountClosureModule {}
