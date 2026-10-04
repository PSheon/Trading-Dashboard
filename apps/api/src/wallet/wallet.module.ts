import { Module } from "@nestjs/common";

import { AuthModule } from "../common/auth/auth.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { ArbitrumBalanceClient } from "./arbitrum-balance.client.js";
import { WalletController } from "./wallet.controller.js";
import { WalletRepository } from "./wallet.repository.js";
import { WalletService } from "./wallet.service.js";
import { WithdrawalController } from "./withdrawal.controller.js";
import { AdminWithdrawalController } from "./admin-withdrawal.controller.js";
import { WithdrawalRepository } from "./withdrawal.repository.js";
import { WithdrawalExchangeClient } from "./withdrawal-exchange.client.js";
import { WithdrawalService } from "./withdrawal.service.js";

/** Main-account balances, ledger and explicitly signed withdrawal intents. */
@Module({
  imports: [AuthModule, HyperliquidModule],
  controllers: [WalletController, WithdrawalController, AdminWithdrawalController],
  providers: [WalletRepository, WalletService, ArbitrumBalanceClient, WithdrawalRepository, WithdrawalService, WithdrawalExchangeClient],
})
export class WalletModule {}
