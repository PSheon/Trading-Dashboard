import { Body, Controller, Get, Header, HttpCode, Param, Post, UseFilters } from '@nestjs/common';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { BusyFilter } from '../traders/busy.js';
import { CopyLiveStopService } from './copy-live-stop.service.js';
import { CopyWalletIdDto } from './dto/copy-wallet.dto.js';
import { LiveCopyOperationKeyDto } from './dto/copy-live-mandate.dto.js';
import { RequestLiveCopyStopDto } from './dto/copy-live-stop.dto.js';

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
  @Get('stops') @Header('Cache-Control', 'no-store')
  @ApiDoc('Read my durable stop operation history', 'Bounded to 100 operations with unfinished operations first. Read only.')
  overview(@CurrentUser() user: RequestUser | null) { return this.stops.overview(requireUserId(user)); }
  @Get('stops/by-key/:key') @Header('Cache-Control', 'no-store')
  @ApiDoc('Recover my original stop operation by key', 'Does not replay financial work or change the original request.')
  byKey(@CurrentUser() user: RequestUser | null, @Param() params: LiveCopyOperationKeyDto) {
    return this.stops.byKey(requireUserId(user), params.key);
  }
}
