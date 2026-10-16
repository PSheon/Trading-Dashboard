import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { copyIdempotencyKeySchema, requestLiveCopyStopSchema } from '@trading-dashboard/shared/contracts';
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
  // Reads take no lock (one read-only snapshot): the owner's copy lock is the
  // live order path's, and the overview held it ~4 s per poll for an owner
  // with 105 stops, so the order's try-lock failed live_risk_busy until its
  // signal expired (gate 11, 2026-10-16).
  async byKey(userId: number, value: unknown) {
    const key = input(copyIdempotencyKeySchema, value);
    return this.uow.read(async tx => this.repository.wire(await this.repository.byKey(tx, userId, key)));
  }
  async overview(userId: number) { return this.uow.read(tx => this.repository.overview(tx, userId)); }
}
