import { Module } from "@nestjs/common";

import { AppConfig } from "../config/app-config.js";
import { HyperliquidGlobalTransport } from "../hyperliquid/hyperliquid-global-transport.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
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
    { provide: CopyFundingExchangeClient, inject: [RequestBudgeterService, HyperliquidGlobalTransport],
      useFactory: (budget: RequestBudgeterService, transport: HyperliquidGlobalTransport) => new CopyFundingExchangeClient(budget, transport) },
    { provide: MASTER_POLICY, inject: [AppConfig], useFactory: (config: AppConfig) => new PrivyMasterPolicy(config.value.auth) },
    { provide: COPY_ACCOUNT_CLOSURE, useClass: CopyAccountClosureService },
  ],
  exports: [COPY_ACCOUNT_CLOSURE],
})
export class CopyAccountClosureModule {}
