import { Module } from "@nestjs/common";

import { AuthModule } from "../common/auth/auth.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { ArbitrumBalanceClient } from "./arbitrum-balance.client.js";
import { WalletController } from "./wallet.controller.js";
import { WalletRepository } from "./wallet.repository.js";
import { WalletService } from "./wallet.service.js";

/** /me/wallet: the user's main-account balances and ledger (read only). */
@Module({
  imports: [AuthModule, HyperliquidModule],
  controllers: [WalletController],
  providers: [WalletRepository, WalletService, ArbitrumBalanceClient],
})
export class WalletModule {}
