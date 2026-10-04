import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, requireUserId, type RequestUser } from '../common/auth/current-user.js';
import { Public } from '../common/auth/public.decorator.js';
import { ApiDoc } from '../common/decorators/http.decorator.js';
import { ReferralClaimDto, ReferralClaimIdDto, ReferralClaimKeyDto, ReferralCodeDto, ReferralPageDto } from './dto/referral.dto.js';
import { ReferralService } from './referral.service.js';

@Controller('me/referral')
export class ReferralController {
  constructor(private readonly referrals: ReferralService) {}
  @Get() @Header('Cache-Control', 'no-store') @ApiDoc('Read my referral code, eligibility and confirmed balances')
  me(@CurrentUser() user: RequestUser | null) { return this.referrals.me(requireUserId(user)); }
  @Post('code') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Customize my referral code while retaining existing links')
  code(@CurrentUser() user: RequestUser | null, @Body() body: ReferralCodeDto) { return this.referrals.setCode(requireUserId(user), body.code); }
  @Post('bind') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Bind my first eligible referrer')
  bind(@CurrentUser() user: RequestUser | null, @Body() body: ReferralCodeDto) { return this.referrals.bind(requireUserId(user), body.code); }
  @Get('friends') @Header('Cache-Control', 'no-store') @ApiDoc('List my anonymized referrals')
  friends(@CurrentUser() user: RequestUser | null, @Query() query: ReferralPageDto) { return this.referrals.friends(requireUserId(user), query); }
  @Get('claims') @Header('Cache-Control', 'no-store') @ApiDoc('Read my durable claim history')
  claims(@CurrentUser() user: RequestUser | null, @Query() query: ReferralPageDto) { return this.referrals.claims(requireUserId(user), query); }
  @Get('claims/by-key/:key') @Header('Cache-Control', 'no-store') @ApiDoc('Read my original claim by its idempotency key without submitting')
  getClaimByKey(@CurrentUser() user: RequestUser | null, @Param() params: ReferralClaimKeyDto) { return this.referrals.getClaimByKey(requireUserId(user), params.key); }
  @Get('claims/:id') @Header('Cache-Control', 'no-store') @ApiDoc('Resolve my original claim even when my balance is zero')
  getClaim(@CurrentUser() user: RequestUser | null, @Param() params: ReferralClaimIdDto) { return this.referrals.getClaim(requireUserId(user), params.id); }
  @Post('claims') @HttpCode(200) @Header('Cache-Control', 'no-store') @ApiDoc('Resolve an existing referral claim', 'New payouts remain unavailable until trusted collection and payout adapters are registered. Never fabricates a reward or payment.')
  claim(@CurrentUser() user: RequestUser | null, @Body() body: ReferralClaimDto) { return this.referrals.claim(requireUserId(user), body.idempotencyKey); }
}

@Controller('referral')
export class ReferralPublicController {
  constructor(private readonly referrals: ReferralService) {}
  @Public() @Get('check/:code') @Header('Cache-Control', 'no-store') @ApiDoc('Check referral code validity without revealing its owner')
  check(@Param() params: ReferralCodeDto) { return this.referrals.check(params.code); }
}
