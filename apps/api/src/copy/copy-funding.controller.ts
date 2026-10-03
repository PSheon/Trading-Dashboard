import { Body, Controller, Get, Header, HttpCode, Param, Post, UseFilters } from "@nestjs/common";
import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { BusyFilter } from "../traders/busy.js";
import { CopyWalletIdDto } from "./dto/copy-wallet.dto.js";
import { CopyFundingIdDto, CopyFundingInputDto, CopyFundingSubmitDto } from "./dto/copy-funding.dto.js";
import { CopyFundingService } from "./copy-funding.service.js";

@Controller("me/copy")
@UseFilters(BusyFilter)
export class CopyFundingController {
  constructor(private readonly funding: CopyFundingService) {}
  @Get("funding") @Header("Cache-Control", "no-store") @ApiDoc("List my durable strategy funding operations", "Testnet setup only; does not activate paper or live strategies.")
  overview(@CurrentUser() user: RequestUser | null) { return this.funding.overview(requireUserId(user)); }
  @Post("execution-wallets/:id/funding") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Reserve testnet strategy funding", "Destination is the verified user-owned execution account. No funds are moved by reservation.")
  reserve(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: CopyFundingInputDto) { return this.funding.reserve(requireUserId(user), params.id, body); }
  @Post("funding/:id/broadcast") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Claim one funding submission permission")
  claim(@CurrentUser() user: RequestUser | null, @Param() params: CopyFundingIdDto) { return this.funding.claim(requireUserId(user), params.id); }
  @Post("funding/:id/submit") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Submit the exact owner-signed funding intent", "One attempt only. Exchange acknowledgement remains accepted until recipient ledger and transaction nonce confirm credit.")
  submit(@CurrentUser() user: RequestUser | null, @Param() params: CopyFundingIdDto, @Body() body: CopyFundingSubmitDto) { return this.funding.submit(requireUserId(user), params.id, body.signature); }
  @Post("funding/:id/cancel") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Cancel an unattempted funding intent")
  cancel(@CurrentUser() user: RequestUser | null, @Param() params: CopyFundingIdDto) { return this.funding.cancel(requireUserId(user), params.id); }
  @Post("funding/:id/reconcile") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Confirm the original funding nonce and recipient credit", "Lookup only; missing evidence never authorizes another transfer.")
  reconcile(@CurrentUser() user: RequestUser | null, @Param() params: CopyFundingIdDto) { return this.funding.reconcile(requireUserId(user), params.id); }
}
