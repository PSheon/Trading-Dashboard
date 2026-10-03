import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import {
  DEFAULT_COPY_RISK_LIMITS,
  coinDex,
  coinKey,
  copyRiskLimitsSchema,
  putCopyRiskRequestSchema,
  type AdminCopyRiskResponse,
  type CopyRiskLimits,
} from "@trading-dashboard/shared/contracts";

import { recordAdminAudit } from "../common/audit/admin-audit.js";
import type { RequestUser } from "../common/auth/current-user.js";
import { hasPermission } from "../common/auth/permissions.js";
import { parseOr400 } from "../common/http/validation.js";
import { UnitOfWork, type DbExecutor } from "../db/unit-of-work.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import { CopyMarketService } from "./copy-market.service.js";
import { CopyRepository } from "./copy.repository.js";

export interface PolicyRead {
  version: number;
  limits: CopyRiskLimits;
  /** The stored policy failed validation: new risk is refused (fail closed). */
  invalid: boolean;
  reason: string | null;
  createdAt: Date | null;
}

/**
 * The copy risk policy: immutable versions (review A07), the newest in
 * force. `current()` reads the database on every call (no cache) and every
 * order records the version it was approved under. Version 0 = never
 * edited, the schema defaults.
 */
@Injectable()
export class CopyRiskPolicyService {
  private readonly logger = new Logger(CopyRiskPolicyService.name);

  constructor(
    private readonly repository: CopyRepository,
    private readonly uow: UnitOfWork,
    private readonly market: CopyMarketService,
    private readonly info: HyperliquidInfoClient,
  ) {}

  async current(ex?: DbExecutor): Promise<PolicyRead> {
    const row = await this.repository.latestPolicy(ex);
    if (!row) return { version: 0, limits: DEFAULT_COPY_RISK_LIMITS, invalid: false, reason: null, createdAt: null };
    const parsed = copyRiskLimitsSchema.safeParse(row.limits);
    if (!parsed.success) {
      this.logger.error(`Copy risk policy v${row.version} is invalid; new copy risk is refused until an admin saves a valid one`);
      return { version: row.version, limits: DEFAULT_COPY_RISK_LIMITS, invalid: true, reason: row.reason, createdAt: row.createdAt };
    }
    return { version: row.version, limits: parsed.data, invalid: false, reason: row.reason, createdAt: row.createdAt };
  }

  /** Read model for the admin risk form (needs copy.read at the route). */
  async get(): Promise<AdminCopyRiskResponse> {
    const [policy, history] = await Promise.all([this.current(), this.repository.policyHistory()]);
    return { version: policy.version, limits: policy.limits, reason: policy.reason, createdAt: policy.createdAt, history };
  }

  /**
   * Saves a whole new version (the admin API: AdminCopyController). `input` is
   * parsed here with putCopyRiskRequestSchema (strict, bounded, cross-field
   * checks). Every blocked coin is resolved to Hyperliquid's own spelling
   * from the live universe (case-insensitive via coinKey); an unknown name
   * is a 400, and an unreachable universe a 503 (nothing saved). Needs
   * risk.manage. 409 stale_version unless `expectedVersion` is current.
   * Audited (copy.risk) in the same transaction. Tightening applies to the
   * next decision, including execution-time revalidation of approved orders.
   */
  async put(input: unknown, actor: RequestUser): Promise<AdminCopyRiskResponse> {
    if (!hasPermission(actor, "risk.manage")) throw new ForbiddenException("Requires risk.manage");
    const req = parseOr400(putCopyRiskRequestSchema, input);
    const limits: CopyRiskLimits = { ...req.limits, blockedCoins: await this.canonicalCoins(req.limits.blockedCoins) };
    const actorUserId = actor.kind === "user" ? actor.id : null;
    await this.uow.run(async (tx) => {
      await this.repository.lockPolicies(tx);
      const latest = await this.repository.latestPolicy(tx);
      const version = latest?.version ?? 0;
      if (version !== req.expectedVersion) {
        throw new ConflictException({ statusCode: 409, code: "stale_version", version, message: "The risk policy changed since this page loaded" });
      }
      const row = await this.repository.insertPolicy(tx, limits as unknown as Record<string, unknown>, req.reason, actorUserId);
      await recordAdminAudit(tx, actor, "copy.risk", `policy:${row.version}`, latest ? { version, limits: latest.limits } : { version: 0 }, { version: row.version, limits, reason: req.reason });
    });
    return this.get();
  }

  /** Hyperliquid's spelling of each name, matched case-insensitively. */
  private async canonicalCoins(names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const byDex = new Map<string, Map<string, string>>();
    const universe = async (dex: string) => {
      if (!byDex.has(dex)) {
        let list: string[] | null = null;
        if (dex === "") list = [...((await this.market.assetInfo())?.keys() ?? [])];
        else list = (await this.info.meta(dex).catch(() => null))?.universe.map((a) => a.name) ?? null;
        if (!list || list.length === 0) throw new ServiceUnavailableException("The Hyperliquid coin list is unavailable; try again");
        byDex.set(dex, new Map(list.map((n) => [coinKey(n), n])));
      }
      return byDex.get(dex)!;
    };
    const out: string[] = [];
    for (const name of names) {
      const hit = (await universe(coinDex(name))).get(coinKey(name));
      if (!hit) throw new BadRequestException({ statusCode: 400, code: "unknown_coin", coin: name, message: `${name} is not a Hyperliquid perp` });
      if (!out.includes(hit)) out.push(hit);
    }
    return out;
  }
}
