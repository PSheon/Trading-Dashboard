import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post, UseFilters } from '@nestjs/common';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { PRIVY_IDENTITY_TOKEN_HEADER, privyWalletJwt } from '../common/auth/privy-wallet-session.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { BusyFilter } from '../traders/busy.js';
import { CopyAccountModeService } from './copy-account-mode.service.js';
import { CopyWalletIdDto } from './dto/copy-wallet.dto.js';
import { ApproveCopyAccountModeDto, CopyAccountModeKeyDto, PrepareCopyAccountModeDto } from './dto/copy-account-mode.dto.js';
@Controller('me/copy') @UseFilters(BusyFilter)
export class CopyAccountModeController {
  constructor(private readonly modes: CopyAccountModeService) {}
  @Get('account-modes') @Header('Cache-Control', 'no-store') @ApiDoc('List my dedicated account mode setup operations')
  overview(@CurrentUser() user: RequestUser | null) { return this.modes.overview(requireUserId(user)); }
  @Get('account-modes/by-key/:key') @Header('Cache-Control', 'no-store') @ApiDoc('Recover the original account mode preparation by its owner idempotency key')
  byKey(@CurrentUser() user: RequestUser | null, @Param() params: CopyAccountModeKeyDto) { return this.modes.byKey(requireUserId(user), params.key); }
  @Post('execution-wallets/:id/mode') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Prepare an explicit testnet standard-mode operation', 'Reserves an operation only; never signs, funds or starts trading.')
  prepare(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: PrepareCopyAccountModeDto) { return this.modes.prepare(requireUserId(user), params.id, body); }
  @Post('account-modes/:id/challenge') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Prepare exact owner consent for a dormant dedicated testnet account')
  challenge(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto) { return this.modes.challenge(requireUserId(user), params.id); }
  @Post('account-modes/:id/reconcile') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Read the original account mode operation without signing or resubmission')
  reconcile(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto) { return this.modes.reconcile(requireUserId(user), params.id); }
  @Post('account-modes/:id/approve') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Set the explicitly reviewed dormant testnet account to standard mode', 'Requires exact owner consent and fresh user JWT; one durable attempt only, followed by separate mode observation.')
  approve(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: ApproveCopyAccountModeDto, @Headers('authorization') authorization?: string, @Headers(PRIVY_IDENTITY_TOKEN_HEADER) identity?: string) {
    const userId = requireUserId(user);
    return this.modes.approve(userId, params.id, body.consentSignature, privyWalletJwt(user, authorization, identity));
  }
}
