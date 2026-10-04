import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { AdminLiveAccounts, AdminLiveLatency, AdminLiveOrders, AdminLiveTransfers, AdminRevokedLiveGrant } from "@trading-dashboard/shared/contracts";

import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { RequirePermissions } from "../common/auth/permissions.js";
import { ApiDoc, ResponseMessage } from "../common/decorators/http.decorator.js";
import { CopyAdminLiveService } from "../copy/copy-admin-live.service.js";
import { AdminLiveGrantParamsDto, AdminLiveLatencyQueryDto, AdminLiveOrdersQueryDto, AdminRevokeLiveGrantDto } from "./dto/copy-live.dto.js";

/**
 * Testnet copy operations for the admin (B16) and copy latency (B18): every
 * execution wallet with its agent and grant, wallet transfers, orders whose
 * exchange outcome is open or unknown, P50/P95 leader fill → order. Reads
 * need copy.read; revoking a grant needs execution.pause and is audited.
 */
@Controller("admin/copy/live")
@RequirePermissions("admin.access", "copy.read")
export class AdminCopyLiveController {
  constructor(private readonly live: CopyAdminLiveService) {}

  @ApiDoc("Testnet execution wallets with their agent, trading grant, mandate and stop")
  @Header("Cache-Control", "no-store")
  @Get("accounts")
  accounts(): Promise<AdminLiveAccounts> { return this.live.accounts(); }

  @ApiDoc("Testnet copy wallet transfers: deposits from and returns to main wallets, newest first")
  @Header("Cache-Control", "no-store")
  @Get("transfers")
  transfers(): Promise<AdminLiveTransfers> { return this.live.transfers(); }

  @ApiDoc("Testnet orders by journal state", "open: not terminal yet; unknown: sent, outcome not yet confirmed (the worker reconciles by cloid; never placed after expiry + 30 s)")
  @Header("Cache-Control", "no-store")
  @Get("orders")
  orders(@Query() query: AdminLiveOrdersQueryDto): Promise<AdminLiveOrders> { return this.live.orders(query.state); }

  @ApiDoc("Copy latency P50/P95 in ms from the leader's fill: signal received, order sent, exchange answer, fill booked")
  @Header("Cache-Control", "no-store")
  @Get("latency")
  latency(@Query() query: AdminLiveLatencyQueryDto): Promise<AdminLiveLatency> { return this.live.latency(query.window); }

  @ApiDoc("Revoke a testnet copy's trading grant", "Needs execution.pause; audited as copy.grant.revoke. A copy that may still hold positions or orders is stopped at once (no new risk) and the grant, limited to reductions, is revoked when that stop ends (revokeRequestedAt, stopId); an ended copy's grant is revoked at once (revokedAt). 409 live_revoke_needs_stop when the copy cannot be stopped.")
  @RequirePermissions("admin.access", "copy.read", "execution.pause")
  @ResponseMessage("Grant revoked")
  @Post("grants/:id/revoke") @HttpCode(200)
  revoke(@Param() params: AdminLiveGrantParamsDto, @Body() body: AdminRevokeLiveGrantDto, @CurrentUser() user: RequestUser | null): Promise<AdminRevokedLiveGrant> {
    return this.live.revoke(params.id, body, user!);
  }
}
