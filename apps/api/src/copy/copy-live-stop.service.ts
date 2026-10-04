import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { approveLiveStopCancellationSchema, copyIdempotencyKeySchema, liveStopCancellationChallengeSchema, requestLiveCopyStopSchema } from '@trading-dashboard/shared/contracts';
import { ForbiddenException } from '@nestjs/common';
import { liveStopCancellationIntentDigest, verifyLiveStopCancellationConsent } from './copy-live-stop-consent.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { CopyLiveStopRepository } from './copy-live-stop.repository.js';
const id = z.string().min(1).max(128).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Invalid stop request');
  return structuredClone(result.data);
}
@Injectable()
export class CopyLiveStopService {
  constructor(private readonly repository: CopyLiveStopRepository, private readonly uow: UnitOfWork,
    @Optional() private readonly now: () => number = Date.now) {}
  async request(userId: number, mandateId: string, value: unknown) {
    const originalId = input(id, mandateId), request = input(requestLiveCopyStopSchema, value);
    return this.uow.run(async tx => this.repository.wire(await this.repository.request(tx, userId, originalId, request, this.now)));
  }
  async byKey(userId: number, value: unknown) {
    const key = input(copyIdempotencyKeySchema, value);
    return this.uow.run(async tx => this.repository.wire(await this.repository.byKey(tx, userId, key)));
  }
  async overview(userId: number) { return this.uow.run(tx => this.repository.overview(tx, userId)); }
  /** The owner's consent challenge to cancel a cancelling stop's tracked orders. */
  async cancellationChallenge(userId: number, stopId: string) {
    const original = input(z.string().uuid(), stopId);
    return liveStopCancellationChallengeSchema.parse(await this.uow.run(tx => this.repository.cancellationChallenge(tx, userId, original, this.now)));
  }
  /** Verifies the owner's signature over the exact current intent, then records it. */
  async approveCancellation(userId: number, stopId: string, value: unknown) {
    const original = input(z.string().uuid(), stopId), body = input(approveLiveStopCancellationSchema, value);
    const held = await this.repository.consentIntent(userId, original);
    if (!held) throw new BadRequestException('Request the cancellation consent first');
    if (!await verifyLiveStopCancellationConsent(held.intent, body.consentSignature, this.now())) throw new ForbiddenException('Invalid owner consent');
    const digest = liveStopCancellationIntentDigest(held.intent);
    return liveStopCancellationChallengeSchema.parse(await this.uow.run(tx => this.repository.approveCancellation(tx, userId, original, digest, body.consentSignature, this.now)));
  }
}
