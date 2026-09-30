import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { kolAvatars, kolTraders } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

/** A KOL with its avatar row's bookkeeping (no bytes). */
export interface AvatarCandidate {
  address: string;
  avatarUrl: string | null;
  xHandle: string | null;
  /** Null when never attempted. */
  source: string | null;
  etag: string | null;
  nextAttemptAt: Date | null;
  failures: number | null;
}

export interface StoredAvatar {
  bytes: Buffer;
  contentType: string;
  etag: string;
}

/** The KOL card the trader page header shows. */
export interface KolCardRow {
  displayName: string | null;
  xHandle: string | null;
  verified: boolean;
  avatarEtag: string | null;
}

const mine = eq(kolAvatars.chain, CHAIN_DEFAULT);

/** `kol_avatars`: the api's avatar cache for the KOL registry. Single-row
 * writes; no caller transaction is needed (the drip job is the only writer). */
@Injectable()
export class KolAvatarRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Every KOL, in registry order, with its avatar bookkeeping. */
  async candidates(): Promise<AvatarCandidate[]> {
    return this.db
      .select({
        address: kolTraders.address,
        avatarUrl: kolTraders.avatarUrl,
        xHandle: kolTraders.xHandle,
        source: kolAvatars.source,
        etag: kolAvatars.etag,
        nextAttemptAt: kolAvatars.nextAttemptAt,
        failures: kolAvatars.failures,
      })
      .from(kolTraders)
      .leftJoin(kolAvatars, and(eq(kolAvatars.chain, kolTraders.chain), eq(kolAvatars.address, kolTraders.address)))
      .where(eq(kolTraders.chain, CHAIN_DEFAULT))
      .orderBy(asc(kolTraders.sortOrder), asc(kolTraders.address));
  }

  /** The cached image, or undefined when none was fetched yet. */
  async find(address: string): Promise<StoredAvatar | undefined> {
    const [row] = await this.db
      .select({ bytes: kolAvatars.bytes, contentType: kolAvatars.contentType, etag: kolAvatars.etag })
      .from(kolAvatars)
      .where(and(mine, eq(kolAvatars.address, address)))
      .limit(1);
    if (!row?.bytes || !row.contentType || !row.etag) return undefined;
    return { bytes: row.bytes, contentType: row.contentType, etag: row.etag };
  }

  /** The KOL entry of `address` with its cached avatar's ETag; undefined
   * when the address is not a KOL. */
  async card(address: string): Promise<KolCardRow | undefined> {
    const [row] = await this.db
      .select({
        displayName: kolTraders.displayName,
        xHandle: kolTraders.xHandle,
        verified: kolTraders.verified,
        avatarEtag: sql<string | null>`case when ${kolAvatars.bytes} is null then null else ${kolAvatars.etag} end`,
      })
      .from(kolTraders)
      .leftJoin(kolAvatars, and(eq(kolAvatars.chain, kolTraders.chain), eq(kolAvatars.address, kolTraders.address)))
      .where(and(eq(kolTraders.chain, CHAIN_DEFAULT), eq(kolTraders.address, address)))
      .limit(1);
    return row;
  }

  /** Drops the avatars of addresses no longer in the registry; returns how many. */
  async removeOrphans(): Promise<number> {
    const rows = await this.db
      .delete(kolAvatars)
      .where(and(mine, sql`not exists (select 1 from ${kolTraders} where ${kolTraders.chain} = ${kolAvatars.chain} and ${kolTraders.address} = ${kolAvatars.address})`))
      .returning({ address: kolAvatars.address });
    return rows.length;
  }

  /** Stores a fetched image; the next attempt is the weekly refresh. */
  async saveImage(address: string, source: string, image: StoredAvatar, now: Date, nextAttemptAt: Date): Promise<void> {
    const values = {
      source, bytes: image.bytes, contentType: image.contentType, etag: image.etag,
      fetchedAt: now, attemptedAt: now, nextAttemptAt, failures: 0, lastError: null,
    };
    await this.db
      .insert(kolAvatars)
      .values({ chain: CHAIN_DEFAULT, address, ...values })
      .onConflictDoUpdate({ target: [kolAvatars.chain, kolAvatars.address], set: values });
  }

  /**
   * Records a failed attempt. A previous image is kept when the source is
   * unchanged (a failed weekly refresh still serves last week's picture);
   * a new source drops it, since it shows someone else's choice.
   */
  async saveFailure(address: string, source: string, error: string, now: Date, nextAttemptAt: Date): Promise<void> {
    await this.db
      .insert(kolAvatars)
      .values({ chain: CHAIN_DEFAULT, address, source, attemptedAt: now, nextAttemptAt, failures: 1, lastError: error })
      .onConflictDoUpdate({
        target: [kolAvatars.chain, kolAvatars.address],
        set: {
          attemptedAt: now,
          nextAttemptAt,
          lastError: error,
          failures: sql`case when ${kolAvatars.source} = ${source} then ${kolAvatars.failures} + 1 else 1 end`,
          bytes: sql`case when ${kolAvatars.source} = ${source} then ${kolAvatars.bytes} else null end`,
          contentType: sql`case when ${kolAvatars.source} = ${source} then ${kolAvatars.contentType} else null end`,
          etag: sql`case when ${kolAvatars.source} = ${source} then ${kolAvatars.etag} else null end`,
          fetchedAt: sql`case when ${kolAvatars.source} = ${source} then ${kolAvatars.fetchedAt} else null end`,
          source,
        },
      });
  }
}
