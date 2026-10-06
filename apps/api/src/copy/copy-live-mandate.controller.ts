import { Body, Controller, Get, Header, HttpCode, Param, Post, UseFilters } from '@nestjs/common';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { BusyFilter } from '../traders/busy.js';
import { CopyLiveMandateService } from './copy-live-mandate.service.js';
import { CopyWalletIdDto } from './dto/copy-wallet.dto.js';
import { EmptyLiveCopyMandateDto } from './dto/copy-live-mandate.dto.js';

@Controller('me/copy/live')
@UseFilters(BusyFilter)
export class CopyLiveMandateController {
  constructor(private readonly mandates: CopyLiveMandateService) {}
  @Get() @Header('Cache-Control', 'no-store') @ApiDoc('Read my dedicated testnet copy strategies and local owner mandates')
  overview(@CurrentUser() user: RequestUser | null) { return this.mandates.overview(requireUserId(user)); }
  @Post('mandates/:id/pause') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Pause new risk locally without cancelling orders or settling funds')
  pause(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: EmptyLiveCopyMandateDto) { return this.mandates.pause(requireUserId(user), params.id, body); }
  @Post('mandates/:id/resume') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Resume a paused generation', 'No signature: the generation\'s consent covers it until it expires. Controls must be clear and no stop in progress.')
  resume(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: EmptyLiveCopyMandateDto) { return this.mandates.resume(requireUserId(user), params.id, body); }
  @Post('mandates/:id/revoke') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Revoke local execution consent', 'Preserves all orders, unknown receipts and financial liabilities for reconciliation.')
  revoke(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: EmptyLiveCopyMandateDto) { return this.mandates.revoke(requireUserId(user), params.id, body); }
}
