import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, UseFilters } from '@nestjs/common';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { BusyFilter } from '../traders/busy.js';
import { CopyStrategyParamsDto } from './dto/copy.dto.js';
import { AdvanceLiveCopySetupDto, ConfirmLiveCopySetupDto, EditLiveCopyDto, LiveSetupIdDto, RenewLiveCopyDto, StartLiveCopyDto } from './dto/copy-live-setup.dto.js';
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
  @Post('setups/:id/confirm') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Confirm with the setup consent and the deposit signature', "Records the worker signer my browser added to the copy account (Privy addSigners), verifies the consent once, submits the deposit once, then runs what it can. Without the worker signer nothing is deposited: 409 worker_signer_missing (confirm again once it is added, while the consent lasts).")
  confirm(@CurrentUser() user: RequestUser | null, @Param() params: LiveSetupIdDto, @Body() body: ConfirmLiveCopySetupDto) {
    const userId = requireUserId(user); return this.setups.confirm(userId, params.id, body);
  }
  @Post('setups/:id/advance') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Drive a confirmed setup now', "Runs the setup's next steps now, signed by the worker under the owner's policy (the worker's own pass does the same). Takes no body: a body (such as a browser signature) is refused 400. Attempted steps are only reconciled, never resent.")
  advance(@CurrentUser() user: RequestUser | null, @Param() params: LiveSetupIdDto, @Body() body: AdvanceLiveCopySetupDto) {
    const userId = requireUserId(user); return this.setups.advance(userId, params.id, { ...body });
  }
  @Post('setups/:id/cancel') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Cancel or end a setup', "Before its consent was confirmed (the reserved deposit is cancelled), or once it failed or expired. A start that never ran a generation stops its copy; a deposit that arrived stays in the copy account and is returned to the main wallet from the portfolio. 409 funding_pending while a confirmed setup is still going.")
  cancel(@CurrentUser() user: RequestUser | null, @Param() params: LiveSetupIdDto) { return this.setups.cancel(requireUserId(user), params.id); }
  @Patch('strategies/:id') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Edit a testnet copy', 'A new generation with the new settings or budget under one setup consent; the current one keeps running until the consent is confirmed.')
  edit(@CurrentUser() user: RequestUser | null, @Param() params: CopyStrategyParamsDto, @Body() body: EditLiveCopyDto) { return this.setups.startEdit(requireUserId(user), params.id, body); }
  @Post('strategies/:id/renew') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Renew a testnet copy', 'Refused for now: 409 renewal_unavailable (a new agent needs a new worker policy added from the browser).')
  renew(@CurrentUser() user: RequestUser | null, @Param() params: CopyStrategyParamsDto, @Body() body: RenewLiveCopyDto) { return this.setups.startRenewal(requireUserId(user), params.id, body); }
}
