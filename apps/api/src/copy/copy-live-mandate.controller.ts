import { Body, Controller, Get, Header, HttpCode, Param, Post, UseFilters } from '@nestjs/common';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { BusyFilter } from '../traders/busy.js';
import { CopyLiveMandateService } from './copy-live-mandate.service.js';
import { CopyWalletIdDto } from './dto/copy-wallet.dto.js';
import { EmptyLiveCopyMandateDto, LiveCopyOperationKeyDto, CreateLiveCopyStrategyDto, PrepareLiveCopyMandateDto, ApproveLiveCopyMandateDto } from './dto/copy-live-mandate.dto.js';

@Controller('me/copy/live')
@UseFilters(BusyFilter)
export class CopyLiveMandateController {
  constructor(private readonly mandates: CopyLiveMandateService) {}
  @Get() @Header('Cache-Control', 'no-store') @ApiDoc('Read my dedicated testnet copy strategies and local owner mandates')
  overview(@CurrentUser() user: RequestUser | null) { return this.mandates.overview(requireUserId(user)); }
  @Get('strategies/by-key/:key') @Header('Cache-Control', 'no-store') @ApiDoc('Recover my original dedicated strategy by its local operation key')
  strategyByKey(@CurrentUser() user: RequestUser | null, @Param() params: LiveCopyOperationKeyDto) { return this.mandates.strategyByKey(requireUserId(user), params.key); }
  @Get('mandates/by-key/:key') @Header('Cache-Control', 'no-store') @ApiDoc('Recover my exact original local mandate challenge by key', 'Returns archived expired/revoked evidence without changing its nonce, expiry or state.')
  mandateByKey(@CurrentUser() user: RequestUser | null, @Param() params: LiveCopyOperationKeyDto) { return this.mandates.mandateByKey(requireUserId(user), params.key); }
  @Get('mandates/:id/challenge') @Header('Cache-Control', 'no-store') @ApiDoc('Read the exact original local mandate challenge', 'Recovery does not refresh consent or activate trading.')
  originalChallenge(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto) { return this.mandates.originalChallenge(requireUserId(user), params.id); }
  @Post('strategies') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Prepare a fresh paused testnet copy strategy', 'Creates local configuration only. Does not allocate simulated funds or start execution.')
  create(@CurrentUser() user: RequestUser | null, @Body() body: CreateLiveCopyStrategyDto) { return this.mandates.create(requireUserId(user), body); }
  @Post('execution-wallets/:id/mandates') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Prepare exact local owner consent for a verified testnet agent')
  prepare(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: PrepareLiveCopyMandateDto) { return this.mandates.prepare(requireUserId(user), params.id, body); }
  @Post('mandates/:id/approve') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Acknowledge exact owner consent locally', 'Active acknowledges consent only. The strategy remains paused; automatic execution is unavailable.')
  approve(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: ApproveLiveCopyMandateDto) { return this.mandates.approve(requireUserId(user), params.id, body); }
  @Post('mandates/:id/pause') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Pause new risk locally without cancelling orders or settling funds')
  pause(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: EmptyLiveCopyMandateDto) { return this.mandates.pause(requireUserId(user), params.id, body); }
  @Post('mandates/:id/revoke') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Revoke local execution consent', 'Preserves all orders, unknown receipts and financial liabilities for reconciliation.')
  revoke(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: EmptyLiveCopyMandateDto) { return this.mandates.revoke(requireUserId(user), params.id, body); }
}
