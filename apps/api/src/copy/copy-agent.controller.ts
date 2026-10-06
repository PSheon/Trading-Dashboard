import { Body, Controller, Get, Header, HttpCode, Param, Post, UseFilters } from "@nestjs/common";
import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { BusyFilter } from "../traders/busy.js";
import { CopyAgentService } from "./copy-agent.service.js";
import { CopyWalletIdDto } from "./dto/copy-wallet.dto.js";
import { PrepareCopyAgentDto } from "./dto/copy-agent.dto.js";

@Controller("me/copy")
@UseFilters(BusyFilter)
export class CopyAgentController {
  constructor(private readonly agents: CopyAgentService) {}
  @Get("agents") @Header("Cache-Control", "no-store") @ApiDoc("List my strategy trading agents and setup states")
  overview(@CurrentUser() user: RequestUser | null) { return this.agents.overview(requireUserId(user)); }
  @Post("execution-wallets/:id/agent") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Prepare a user-owned testnet trading agent", "Creates a restricted user-owned agent only; does not approve, fund or start trading.")
  prepare(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: PrepareCopyAgentDto) { return this.agents.prepare(requireUserId(user), params.id, body); }
  @Post("agents/:id/reconcile") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Recover the original agent setup", "Pending approval is queried without resubmission.")
  reconcile(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto) { return this.agents.reconcile(requireUserId(user), params.id); }
}
