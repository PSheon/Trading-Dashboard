import { Injectable } from "@nestjs/common";

import type { DbTransaction } from "../db/unit-of-work.js";
import type { ActionDraft } from "./action-classifier.js";
import { actionsCovering, insertActions, lockActions } from "./action-store.js";

/** Fast-path persistence, using the same address lock and action/outbox writes as FillSync. */
@Injectable()
export class FeedActionsRepository {
  /** Acquire before coverage reads; caller must not perform upstream requests while holding it. */
  lock(tx: DbTransaction, address: string): Promise<void> {
    return lockActions(tx, address);
  }

  covering(tx: DbTransaction, address: string, tids: bigint[], minTime: number) {
    return actionsCovering(tx, address, tids, minTime);
  }

  /** Store actions and recent delivery intents atomically; events follow service commit. */
  insert(tx: DbTransaction, address: string, drafts: ActionDraft[], equityUsd: number | null,
    maxActionAgeSeconds: number) {
    return insertActions(tx, address, drafts, true, equityUsd, maxActionAgeSeconds);
  }
}
