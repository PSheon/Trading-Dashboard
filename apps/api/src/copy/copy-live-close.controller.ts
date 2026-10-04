import { Body, Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { CopyWalletIdDto } from './dto/copy-wallet.dto.js';
import { CopyLiveCloseService } from './copy-live-close.service.js';
import { RequestLiveManualCloseDto } from './dto/copy-live-close.dto.js';


@Controller('me/copy/live')
export class CopyLiveCloseController {
  constructor(private readonly closes: CopyLiveCloseService) {}
  @Post('execution-wallets/:id/positions/close') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @ApiDoc('Close one position of my running testnet copy', 'Recorded now; the worker sends reduce-only IOC orders by the approved agent until the position is flat. The copy keeps following its leader.')
  request(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto, @Body() body: RequestLiveManualCloseDto) { return this.closes.request(requireUserId(user), params.id, body); }
  @Get('execution-wallets/:id/closes') @Header('Cache-Control', 'no-store')
  @ApiDoc('Read my single-position closes of a copy', 'Read only.')
  list(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto) { return this.closes.list(requireUserId(user), params.id); }
}
