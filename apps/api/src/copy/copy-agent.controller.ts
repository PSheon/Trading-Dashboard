import { Body, Controller, Get, Header, HttpCode, Param, Post, UseFilters } from "@nestjs/common";
import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { BusyFilter } from "../traders/busy.js";
import { CopyAgentService } from "./copy-agent.service.js";
import { CopyWalletIdDto } from "./dto/copy-wallet.dto.js";
import { PrepareCopyAgentDto, ApproveCopyAgentDto } from "./dto/copy-agent.dto.js";

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
  @Post("agents/:id/challenge") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Prepare exact main-wallet consent for agent approval")
  challenge(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto) { return this.agents.challenge(requireUserId(user), params.id); }
  @Post("agents/:id/approve") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Approve the exact consented strategy agent", "Requires main-wallet consent and the copy account's own ApproveAgent signature of the challenge's masterAction (made in my browser; 403 agent_master_signature_invalid otherwise). A local grant follows fresh exchange confirmation only.")
  approve(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: ApproveCopyAgentDto) {
    const userId = requireUserId(user);
    return this.agents.approve(userId, params.id, body.consentSignature, body.masterSignature);
  }
}
