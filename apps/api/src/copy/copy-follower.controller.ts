import { Controller, Get, Header, Param, Query } from "@nestjs/common";
import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { CopyFollowerActivityQueryDto } from "./dto/copy-follower-activity.dto.js";
import { CopyWalletIdDto } from "./dto/copy-wallet.dto.js";
import { CopyFollowerStatementService } from "./copy-follower-statement.service.js";
import { CopyFollowerActivityService } from "./copy-follower-activity.service.js";

@Controller("me/copy")
export class CopyFollowerController {
  constructor(private readonly statements: CopyFollowerStatementService, private readonly activity: CopyFollowerActivityService) {}
  @Get("execution-wallets/:id/statement") @Header("Cache-Control", "no-store")
  @ApiDoc("Read my actual follower trading statement", "Actual realised PnL, signed fee components and funding receipts only. Trading cash movement excludes deposits/transfers and is not account equity. Historical completeness remains unproven; unresolved scans and quarantine are explicit.")
  statement(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto) { return this.statements.get(requireUserId(user), params.id); }
  @Get("execution-wallets/:id/activity") @Header("Cache-Control", "no-store")
  @ApiDoc("Read my actual follower receipt history", "Bounded before-only booked fill/funding history for this exact dedicated master. Signed USDC components exclude capital transfers and do not imply equity, ROI or complete provider history.")
  history(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Query() query: CopyFollowerActivityQueryDto) { return this.activity.get(requireUserId(user), params.id, query); }
}
