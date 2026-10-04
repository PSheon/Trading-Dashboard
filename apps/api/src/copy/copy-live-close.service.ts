import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { liveManualCloseSchema, requestLiveManualCloseSchema } from '@trading-dashboard/shared/contracts';
import { CopyLiveCloseRepository, type CloseRow } from './copy-live-close.repository.js';

const wire = (row: CloseRow) => liveManualCloseSchema.parse({ id: row.id, accountId: row.accountId, strategyId: row.strategyId, coin: row.coin, state: row.state,
  reason: row.reason, orders: row.executionKeys.length, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });

/** CopyDog's single-position close on a running testnet copy: a durable
 * request the worker executes with reduce-only IOC orders by the approved
 * agent. The copy keeps following its leader. */
@Injectable()
export class CopyLiveCloseService {
  constructor(private readonly repository: CopyLiveCloseRepository, @Optional() private readonly now: () => number = Date.now) {}
  async request(userId: number, accountId: string, body: unknown) {
    const parsed = requestLiveManualCloseSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid close request');
    return wire(await this.repository.request(userId, accountId, parsed.data.idempotencyKey, parsed.data.coin, new Date(this.now())));
  }
  async list(userId: number, accountId: string) {
    return { items: (await this.repository.list(userId, z.string().max(160).parse(accountId))).map(wire) };
  }
}
