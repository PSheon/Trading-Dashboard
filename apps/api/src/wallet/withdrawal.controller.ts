import { Body, Controller, Get, Header, HttpCode, Param, Post, UseFilters } from "@nestjs/common";
import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { BusyFilter } from "../traders/busy.js";
import { WithdrawalIdDto, WithdrawalImportDto, WithdrawalInputDto, WithdrawalSubmitDto } from "./withdrawal.dto.js";
import { WithdrawalService } from "./withdrawal.service.js";

@Controller("me/wallet/withdrawals")
@UseFilters(BusyFilter)
export class WithdrawalController {
  constructor(private readonly withdrawals: WithdrawalService) {}
  @Get("current") @Header("Cache-Control", "no-store") @ApiDoc("Get my latest durable withdrawal metadata")
  current(@CurrentUser() user: RequestUser | null) { return this.withdrawals.current(requireUserId(user)); }
  @Post() @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Reserve my withdrawal nonce", "Metadata only. Does not sign or transfer funds; competing active intents return 409.")
  reserve(@CurrentUser() user: RequestUser | null, @Body() body: WithdrawalInputDto) { return this.withdrawals.reserve(requireUserId(user), body); }
  @Post("import") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Import my legacy uncertain withdrawal", "Retains the original nonce as unknown. Never broadcasts or trusts a client-provided outcome.")
  import(@CurrentUser() user: RequestUser | null, @Body() body: WithdrawalImportDto) { return this.withdrawals.import(requireUserId(user), body); }
  @Post(":id/broadcast") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Claim one broadcast permission", "Atomically records unknown before submission. A lost response must not be retried as a new withdrawal.")
  claim(@CurrentUser() user: RequestUser | null, @Param() params: WithdrawalIdDto) { return this.withdrawals.claim(requireUserId(user), params.id); }
  @Post(":id/submit") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Submit my signed withdrawal once", "Verifies the main-wallet EIP-712 signature, submits the stored immutable intent, and records trusted exchange evidence. The signature is never persisted. Accepted means exchange acknowledgment, not bridge payout.")
  submit(@CurrentUser() user: RequestUser | null, @Param() params: WithdrawalIdDto, @Body() body: WithdrawalSubmitDto) { return this.withdrawals.submit(requireUserId(user), params.id, body.signature); }
  @Post(":id/cancel") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Cancel unbroadcast preparation", "Only operations with no server exchange attempt can be cancelled. Legacy uncertainty and attempted operations cannot be released by client claims.")
  cancel(@CurrentUser() user: RequestUser | null, @Param() params: WithdrawalIdDto) { return this.withdrawals.cancel(requireUserId(user), params.id); }
  @Post(":id/reconcile") @HttpCode(200) @Header("Cache-Control", "no-store") @ApiDoc("Reconcile my withdrawal against Hyperliquid", "Accepts only matching authoritative withdrawal nonce and amount. Absence from a bounded ledger remains unknown.")
  reconcile(@CurrentUser() user: RequestUser | null, @Param() params: WithdrawalIdDto) { return this.withdrawals.reconcile(requireUserId(user), params.id); }
}
