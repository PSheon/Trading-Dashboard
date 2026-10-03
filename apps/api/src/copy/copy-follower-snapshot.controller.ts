import { Controller, Get, Header, Param } from '@nestjs/common';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { CopyWalletIdDto } from './dto/copy-wallet.dto.js';
import { CopyFollowerSnapshotService } from './copy-follower-snapshot.service.js';

@Controller('me/copy')
export class CopyFollowerSnapshotController {
  constructor(private readonly snapshots: CopyFollowerSnapshotService) {}
  @Get('execution-wallets/:id/snapshot') @Header('Cache-Control', 'no-store')
  @ApiDoc('Read my observed actual perpetual account', 'Cached all-venue testnet equity, positions and remaining exchange orders with original observation times. Unavailable and stale evidence are explicit. This read does not contact the exchange, authorize trading or calculate account ROI.')
  snapshot(@CurrentUser() user: RequestUser | null, @Param() params: CopyWalletIdDto) { return this.snapshots.get(requireUserId(user), params.id); }
}
