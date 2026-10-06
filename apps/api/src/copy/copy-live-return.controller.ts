import { Body, Controller, HttpCode, Param, Post, UseFilters } from '@nestjs/common';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { BusyFilter } from '../traders/busy.js';
import { CopyLiveReturnService } from './copy-live-return.service.js';
import { CopyWalletIdDto } from './dto/copy-wallet.dto.js';
import { CopyFundingIdDto } from './dto/copy-funding.dto.js';
import { ApproveCopyReturnDto, CopyReturnInputDto } from './dto/copy-live-return.dto.js';


@Controller('me/copy/live')
@UseFilters(BusyFilter)
export class CopyLiveReturnController {
  constructor(private readonly returns: CopyLiveReturnService) {}
  @Post('execution-wallets/:id/returns') @HttpCode(200)
  @ApiDoc('Prepare returning USDC from a copy\'s account to my main wallet', 'An amount of idle funds while copying, or "all" once the copy\'s stop is flat. Moves nothing; send it with approve.')
  reserve(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: CopyReturnInputDto) { return this.returns.reserve(requireUserId(user), params.id, body); }
  @Post('returns/:id/approve') @HttpCode(200)
  @ApiDoc('Send the return', 'Signed by the worker under my policy, which allows only my main wallet; takes no body (a signature is refused 400). 409 worker_signer_missing for a copy without the automatic return. One attempt; credit is confirmed from the main wallet\'s ledger.')
  approve(@CurrentUser() user: RequestUser | null, @Param() params: CopyFundingIdDto, @Body() body: ApproveCopyReturnDto) {
    const userId = requireUserId(user); return this.returns.approve(userId, params.id, { ...body });
  }
  @Post('builder-approvals/:id/reconcile') @HttpCode(200)
  @ApiDoc('Check whether the exchange reports my builder fee approval', 'Read only; never resends.')
  reconcileBuilder(@CurrentUser() user: RequestUser | null, @Param() params: CopyFundingIdDto) { return this.returns.reconcileBuilder(requireUserId(user), params.id); }
}
