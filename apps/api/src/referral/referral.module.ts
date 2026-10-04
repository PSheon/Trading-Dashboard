import { Module } from '@nestjs/common';
import { AuthModule } from '../common/auth/auth.module.js';
import { ReferralController, ReferralPublicController } from './referral.controller.js';
import { ReferralRepository } from './referral.repository.js';
import { ReferralService } from './referral.service.js';

@Module({ imports: [AuthModule], controllers: [ReferralController, ReferralPublicController], providers: [ReferralRepository, ReferralService] })
export class ReferralModule {}
