import { Controller, Get, Header, Param } from "@nestjs/common";
import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { CopyWalletIdDto } from "./dto/copy-wallet.dto.js";
import { CopyFollowerStatementService } from "./copy-follower-statement.service.js";

@Controller("me/copy")
export class CopyFollowerController {
  constructor(private readonly statements: CopyFollowerStatementService) {}
  @Get("execution-wallets/:id/statement") @Header("Cache-Control", "no-store")
  @ApiDoc("Read my actual follower trading statement", "Actual realised PnL, signed fee components and funding receipts only. Trading cash movement excludes deposits/transfers and is not account equity. Historical completeness remains unproven; unresolved scans and quarantine are explicit.")
  statement(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto) { return this.statements.get(requireUserId(user), params.id); }
}
