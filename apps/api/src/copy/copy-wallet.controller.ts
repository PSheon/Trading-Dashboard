import { Body, Controller, Get, Header, HttpCode, Param, Post } from "@nestjs/common";
import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { CopyStrategyParamsDto } from "./dto/copy.dto.js";
import { CopyWalletService } from "./copy-wallet.service.js";
import { CopyWalletIdDto, PrepareExecutionWalletDto } from "./dto/copy-wallet.dto.js";

@Controller("me/copy")
export class CopyWalletController {
  constructor(private readonly wallets: CopyWalletService) {}
  @ApiDoc("List my prepared execution accounts and local trading grants")
  @Get("execution-wallets")
  @Header("Cache-Control", "no-store")
  overview(@CurrentUser() user: RequestUser | null) { return this.wallets.overview(requireUserId(user)); }

  @ApiDoc("Prepare a dedicated user-owned wallet", "Creates an empty user-owned wallet only. Never funds or activates a paper strategy, creates a delegated signer, or approves an exchange agent. Ambiguous results are durable and recovered by lookup.")
  @Post("strategies/:id/execution-wallet")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  prepare(@Param() params: CopyStrategyParamsDto, @Body() body: PrepareExecutionWalletDto, @CurrentUser() user: RequestUser | null) {
    return this.wallets.prepare(requireUserId(user), params.id, body);
  }
  @ApiDoc("Recover or reverify my execution wallet", "Unknown creation outcomes only query the original provider identity; they never create another wallet.")
  @Post("execution-wallets/:id/reconcile")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  reconcile(@Param() params: CopyWalletIdDto, @CurrentUser() user: RequestUser | null) { return this.wallets.reconcile(requireUserId(user), params.id); }

  @ApiDoc("Turn on the automatic return for my testnet copy wallet", "With my session, adds Orbie's worker as the wallet's only additional signer, bound by a Privy policy I own: it can return this wallet's USDC only to my main wallet and set the standard account mode, never export the key. 503 setup_unavailable while the deployment has it off (COPY_AUTOMATIC_RETURN).")
  @Post("execution-wallets/:id/automatic-return")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  automaticReturn(@Param() params: CopyWalletIdDto, @CurrentUser() user: RequestUser | null) {
    return this.wallets.enableAutomaticReturn(requireUserId(user), params.id);
  }
  @ApiDoc("Revoke my local trading grant", "Atomically increments the grant version and records consent revocation. Blocks future server signatures; does not remove the exchange agent or cancel orders already accepted by the exchange.")
  @Post("wallet-authorizations/:id/revoke")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  revoke(@Param() params: CopyWalletIdDto, @CurrentUser() user: RequestUser | null) { return this.wallets.revoke(requireUserId(user), params.id); }
}
