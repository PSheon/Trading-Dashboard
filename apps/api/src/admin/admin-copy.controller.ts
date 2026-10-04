import { Body, Controller, Get, Header, Param, Post, Put, Query } from "@nestjs/common";
import type {
  AdminCopyControlResponse,
  AdminCopyExposureResponse,
  AdminCopyOrdersResponse,
  AdminCopyOverview,
  AdminCopyRiskResponse,
  AdminCopyStrategiesResponse,
  AdminCopyStrategyDetail,
} from "@trading-dashboard/shared/contracts";

import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { RequirePermissions } from "../common/auth/permissions.js";
import { ApiDoc, ResponseMessage } from "../common/decorators/http.decorator.js";
import { CopyAdminReadService } from "../copy/copy-admin-read.service.js";
import { CopyControlService } from "../copy/copy-control.service.js";
import { CopyRiskPolicyService } from "../copy/copy-risk-policy.service.js";
import { AdminCopyControlDto, AdminCopyOrdersQueryDto, AdminCopyStrategiesQueryDto, AdminCopyStrategyParamsDto, PutCopyRiskDto } from "./dto/copy.dto.js";

/**
 * The copy-trading admin (Stage 4 hand-off 「跟單管理介面」) over CopyModule's
 * exported services. Reads need `copy.read`. A stop command needs
 * `execution.pause`, a resume `execution.resume` and a risk policy
 * `risk.manage`: the services decide that from the parsed body and write
 * the admin audit event (copy.control / copy.risk) in the same transaction.
 */
@Controller("admin/copy")
@RequirePermissions("admin.access", "copy.read")
export class AdminCopyController {
  constructor(
    private readonly reads: CopyAdminReadService,
    private readonly controls: CopyControlService,
    private readonly policies: CopyRiskPolicyService,
  ) {}

  @ApiDoc("Copy trading overview: mode, platform stop state, counts, signal backlog, recent commands")
  @Header("Cache-Control", "no-store")
  @Get("overview")
  overview(): Promise<AdminCopyOverview> {
    return this.reads.overview();
  }

  @ApiDoc("List copy strategies")
  @Header("Cache-Control", "no-store")
  @Get("strategies")
  strategies(@Query() query: AdminCopyStrategiesQueryDto): Promise<AdminCopyStrategiesResponse> {
    return this.reads.strategies({ status: query.status, userId: query.userId, limit: query.limit });
  }

  @ApiDoc("One copy strategy: settings versions, orders, ledger")
  @Header("Cache-Control", "no-store")
  @Get("strategies/:id")
  strategy(@Param() params: AdminCopyStrategyParamsDto): Promise<AdminCopyStrategyDetail> {
    return this.reads.strategy(params.id);
  }

  @ApiDoc("List copy orders, newest first")
  @Header("Cache-Control", "no-store")
  @Get("orders")
  orders(@Query() query: AdminCopyOrdersQueryDto): Promise<AdminCopyOrdersResponse> {
    return this.reads.orders({ status: query.status, userId: query.userId, strategyId: query.strategyId, limit: query.limit });
  }

  @ApiDoc("Per-user exposure and stop state")
  @Header("Cache-Control", "no-store")
  @Get("exposure")
  exposure(): Promise<AdminCopyExposureResponse> {
    return this.reads.exposure();
  }

  @ApiDoc("Copy risk policy: current version and history")
  @Header("Cache-Control", "no-store")
  @Get("risk")
  risk(): Promise<AdminCopyRiskResponse> {
    return this.policies.get();
  }

  @ApiDoc("Platform- or user-level stop / resume command", "pause_new_risk, reduce_only, cancel_pending and close_positions need execution.pause; resume needs execution.resume. 409 stale_revision when expectedRevision is not the scope's current revision.")
  // Checked here, before the body is read: the service checks again per
  // command (resume also needs execution.resume), so a command added later
  // without its own mapping still needs execution.pause.
  @RequirePermissions("admin.access", "copy.read", "execution.pause")
  @ResponseMessage("Copy control applied")
  @Post("controls")
  control(@Body() body: AdminCopyControlDto, @CurrentUser() user: RequestUser | null): Promise<AdminCopyControlResponse> {
    return this.controls.apply(body, user!);
  }

  @ApiDoc("Save a new copy risk policy version", "Needs risk.manage. 409 stale_version when expectedVersion is not the current version.")
  @RequirePermissions("admin.access", "risk.manage")
  @ResponseMessage("Risk policy saved")
  @Put("risk")
  putRisk(@Body() body: PutCopyRiskDto, @CurrentUser() user: RequestUser | null): Promise<AdminCopyRiskResponse> {
    return this.policies.put(body, user!);
  }
}
