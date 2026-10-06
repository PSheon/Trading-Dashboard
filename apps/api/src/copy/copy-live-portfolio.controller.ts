import { Controller, Get, Header } from '@nestjs/common';
import { liveCopyPortfolioSchema } from '@trading-dashboard/shared/contracts';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { AppConfig } from '../config/app-config.js';
import { CopyLivePortfolioRepository } from './copy-live-portfolio.repository.js';
import { deploymentNetwork, liveExecutionEnabled } from './live-deployment.js';

@Controller('me/copy/live')
export class CopyLivePortfolioController {
  constructor(private readonly config: AppConfig, private readonly repository: CopyLivePortfolioRepository) {}
  @Get('portfolio') @Header('Cache-Control', 'no-store')
  @ApiDoc('Read my actual copies and their stage', 'The deployment\'s network; a copy of another network is history (its `network`). Setup, deposit, funding, awaiting credit, starting, active or paused; stopping, sweeping and stopped. Database only; balances come from the account snapshot.')
  async portfolio(@CurrentUser() user: RequestUser | null) {
    return liveCopyPortfolioSchema.parse({ network: deploymentNetwork(this.config), automaticExecution: liveExecutionEnabled(this.config), items: await this.repository.items(requireUserId(user)) });
  }
}
