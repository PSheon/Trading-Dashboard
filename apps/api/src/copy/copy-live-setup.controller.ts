import { Body, Controller, Get, Header, Headers, HttpCode, Param, Patch, Post, UseFilters } from '@nestjs/common';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { PRIVY_IDENTITY_TOKEN_HEADER, privyWalletJwt } from '../common/auth/privy-wallet-session.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { BusyFilter } from '../traders/busy.js';
import { CopyStrategyParamsDto } from './dto/copy.dto.js';
import { ConfirmLiveCopySetupDto, EditLiveCopyDto, LiveSetupIdDto, RenewLiveCopyDto, StartLiveCopyDto } from './dto/copy-live-setup.dto.js';
import { CopyLiveSetupService } from './copy-live-setup.service.js';

/** One-click testnet copy (docs/one-click-copy-plan-2026-10-05.md §3a). */
@Controller('me/copy/live')
@UseFilters(BusyFilter)
export class CopyLiveSetupController {
  constructor(private readonly setups: CopyLiveSetupService) {}
  @Post('setups') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Start a one-click testnet copy', 'Idempotent by key: prepares the paused strategy, copy wallet, agent and deposit with no exchange call, then returns the one consent challenge. A retry continues preparation and renews an expired challenge.')
  start(@CurrentUser() user: RequestUser | null, @Body() body: StartLiveCopyDto) { return this.setups.start(requireUserId(user), body); }
  @Get('setups') @Header('Cache-Control', 'no-store') @ApiDoc('List my one-click setups')
  list(@CurrentUser() user: RequestUser | null) { return this.setups.list(requireUserId(user)); }
  @Get('setups/:id') @Header('Cache-Control', 'no-store') @ApiDoc('Read one setup (the progress dialog polls it)')
  get(@CurrentUser() user: RequestUser | null, @Param() params: LiveSetupIdDto) { return this.setups.get(requireUserId(user), params.id); }
  @Post('setups/:id/confirm') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Confirm with the setup consent and the deposit signature', "Verifies the consent once, adds the policy-bound worker signer with the owner's session (when the worker policy is on), submits the deposit once, then runs what it can.")
  confirm(@CurrentUser() user: RequestUser | null, @Param() params: LiveSetupIdDto, @Body() body: ConfirmLiveCopySetupDto, @Headers('authorization') authorization?: string, @Headers(PRIVY_IDENTITY_TOKEN_HEADER) identity?: string) {
    const userId = requireUserId(user); return this.setups.confirm(userId, params.id, body, privyWalletJwt(user, authorization, identity));
  }
  @Post('setups/:id/advance') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Continue a setup with my session', "For setups the owner's session signs (worker policy off): the next step's exact consented payload; attempted steps are only reconciled.")
  advance(@CurrentUser() user: RequestUser | null, @Param() params: LiveSetupIdDto, @Headers('authorization') authorization?: string, @Headers(PRIVY_IDENTITY_TOKEN_HEADER) identity?: string) {
    const userId = requireUserId(user); return this.setups.advance(userId, params.id, privyWalletJwt(user, authorization, identity));
  }
  @Post('setups/:id/cancel') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Cancel a setup before its deposit was sent')
  cancel(@CurrentUser() user: RequestUser | null, @Param() params: LiveSetupIdDto) { return this.setups.cancel(requireUserId(user), params.id); }
  @Patch('strategies/:id') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Edit a testnet copy', 'A new generation with the new settings or budget under one setup consent; the current one keeps running until the consent is confirmed.')
  edit(@CurrentUser() user: RequestUser | null, @Param() params: CopyStrategyParamsDto, @Body() body: EditLiveCopyDto) { return this.setups.startEdit(requireUserId(user), params.id, body); }
  @Post('strategies/:id/renew') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Renew a testnet copy', 'In the last three days of its lifetime: a new 30-day agent and generation under one setup consent.')
  renew(@CurrentUser() user: RequestUser | null, @Param() params: CopyStrategyParamsDto, @Body() body: RenewLiveCopyDto) { return this.setups.startRenewal(requireUserId(user), params.id, body); }
}
