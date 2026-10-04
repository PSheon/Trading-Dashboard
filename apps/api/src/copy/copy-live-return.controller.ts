import { Body, Controller, Headers, HttpCode, Param, Post, UnauthorizedException, UseFilters } from '@nestjs/common';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { BusyFilter } from '../traders/busy.js';
import { CopyLiveReturnService } from './copy-live-return.service.js';
import { CopyWalletIdDto } from './dto/copy-wallet.dto.js';
import { CopyFundingIdDto } from './dto/copy-funding.dto.js';
import { ApproveCopyMasterActionDto, CopyBuilderApprovalInputDto, CopyReturnInputDto } from './dto/copy-live-return.dto.js';

function bearer(authorization?: string): string {
  if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim()) throw new UnauthorizedException('Sign in required');
  return authorization.slice(7).trim();
}

@Controller('me/copy/live')
@UseFilters(BusyFilter)
export class CopyLiveReturnController {
  constructor(private readonly returns: CopyLiveReturnService) {}
  @Post('execution-wallets/:id/returns') @HttpCode(200)
  @ApiDoc('Prepare returning USDC from a copy\'s account to my main wallet', 'An amount of idle funds while copying, or "all" once the copy\'s stop is flat. Returns the exact consent to sign; moves nothing.')
  reserve(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: CopyReturnInputDto) { return this.returns.reserve(requireUserId(user), params.id, body); }
  @Post('returns/:id/approve') @HttpCode(200)
  @ApiDoc('Send the return I consented to', 'Requires the main wallet\'s consent and a fresh session; the account signs the exact transfer through Privy, one attempt. Credit is confirmed from the main wallet\'s ledger.')
  approve(@CurrentUser() user: RequestUser | null, @Param() params: CopyFundingIdDto, @Body() body: ApproveCopyMasterActionDto, @Headers('authorization') authorization?: string) {
    const userId = requireUserId(user); return this.returns.approve(userId, params.id, body, bearer(authorization));
  }
  @Post('execution-wallets/:id/builder-approval') @HttpCode(200)
  @ApiDoc('Prepare my copy account\'s approval of the platform builder fee', 'Only while a builder fee above zero is configured. Returns the exact consent to sign.')
  reserveBuilder(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: CopyBuilderApprovalInputDto) { return this.returns.reserveBuilder(requireUserId(user), params.id, body); }
  @Post('builder-approvals/:id/approve') @HttpCode(200)
  @ApiDoc('Send the builder fee approval I consented to', 'Requires the main wallet\'s consent and a fresh session; approved once the exchange reports the fee.')
  approveBuilder(@CurrentUser() user: RequestUser | null, @Param() params: CopyFundingIdDto, @Body() body: ApproveCopyMasterActionDto, @Headers('authorization') authorization?: string) {
    const userId = requireUserId(user); return this.returns.approveBuilder(userId, params.id, body, bearer(authorization));
  }
  @Post('builder-approvals/:id/reconcile') @HttpCode(200)
  @ApiDoc('Check whether the exchange reports my builder fee approval', 'Read only; never resends.')
  reconcileBuilder(@CurrentUser() user: RequestUser | null, @Param() params: CopyFundingIdDto) { return this.returns.reconcileBuilder(requireUserId(user), params.id); }
}
