import { Body, Controller, Get, Header, HttpCode, Param, Post, UseFilters } from '@nestjs/common';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { BusyFilter } from '../traders/busy.js';
import { CopyLiveStopService } from './copy-live-stop.service.js';
import { CopyWalletIdDto } from './dto/copy-wallet.dto.js';
import { LiveCopyOperationKeyDto } from './dto/copy-live-mandate.dto.js';
import { ApproveLiveStopCancellationDto, LiveStopIdDto, RequestLiveCopyStopDto } from './dto/copy-live-stop.dto.js';

@Controller('me/copy/live')
@UseFilters(BusyFilter)
export class CopyLiveStopController {
  constructor(private readonly stops: CopyLiveStopService) {}
  @Post('mandates/:id/stop') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @ApiDoc('Record my original stop request and block new risk locally',
    'Persists the exact owner request and known pending execution targets. Does not sign, cancel, close, release reservations, verify flatness or return funds.')
  request(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: RequestLiveCopyStopDto) {
    return this.stops.request(requireUserId(user), params.id, body);
  }
  @Post('stops/:id/cancellation/challenge') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @ApiDoc('Prepare my consent to cancel a stop\'s tracked orders', 'Only while the stop is cancelling. Returns the exact intent to sign with the main wallet; never signs or cancels.')
  cancellationChallenge(@CurrentUser() user: RequestUser | null, @Param() params: LiveStopIdDto) {
    return this.stops.cancellationChallenge(requireUserId(user), params.id);
  }
  @Post('stops/:id/cancellation') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @ApiDoc('Approve cancelling a stop\'s tracked orders', 'Verifies the main wallet\'s signature over the exact current intent and records its digest. The worker then cancels only those orders.')
  approveCancellation(@CurrentUser() user: RequestUser | null, @Param() params: LiveStopIdDto, @Body() body: ApproveLiveStopCancellationDto) {
    return this.stops.approveCancellation(requireUserId(user), params.id, body);
  }
  @Get('stops') @Header('Cache-Control', 'no-store')
  @ApiDoc('Read my durable stop operation history', 'Bounded to 100 operations with unfinished operations first. Read only.')
  overview(@CurrentUser() user: RequestUser | null) { return this.stops.overview(requireUserId(user)); }
  @Get('stops/by-key/:key') @Header('Cache-Control', 'no-store')
  @ApiDoc('Recover my original stop operation by key', 'Does not replay financial work or change the original request.')
  byKey(@CurrentUser() user: RequestUser | null, @Param() params: LiveCopyOperationKeyDto) {
    return this.stops.byKey(requireUserId(user), params.key);
  }
}
