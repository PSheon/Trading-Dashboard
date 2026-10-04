import { Controller, Get, Header } from "@nestjs/common";
import type { SettingsRuntime } from "@trading-dashboard/shared/contracts";
import { RequirePermissions } from "../common/auth/permissions.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { SettingsService } from "../settings/settings.service.js";
import { AdminSystemService } from "./admin-system.service.js";
@Controller("admin/settings/runtime")
@RequirePermissions("settings.read")
export class AdminSettingsRuntimeController {
  constructor(private readonly settings: SettingsService, private readonly system: AdminSystemService) {}
  @Get()
  @ApiDoc("Get discovery consumer acknowledgements for the sampled worker")
  @Header("Cache-Control", "no-store")
  async get(): Promise<SettingsRuntime> {
    const [saved, system] = await Promise.all([this.settings.getSnapshot(), this.system.overview()]);
    return { savedRevision: saved.revisions.discovery, sampledAt: system.sampledAt,
      state: system.worker.state, instanceId: system.worker.sample?.instanceId ?? null,
      consumers: system.worker.sample?.settings ?? [] };
  }
}
