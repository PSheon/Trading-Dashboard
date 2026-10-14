import { Injectable, Module, type OnApplicationBootstrap } from "@nestjs/common";

import { AppConfig } from "../config/app-config.js";
import { NotifyModule } from "../notify/notify.module.js";
import { FeedMonitorService } from "./feed-monitor.service.js";
import { WatcherModule } from "./watcher.module.js";
import { WatcherService } from "./watcher.service.js";

/** Starts the watcher on the worker's boot: the watch list refresh, the
 * copied catch-up, the trade feed and the startup sweep. Not under
 * `NODE_ENV=test`, where tests drive the pieces directly. */
@Injectable()
export class WatcherRuntime implements OnApplicationBootstrap {
  constructor(private readonly config: AppConfig, private readonly watcher: WatcherService) {}
  onApplicationBootstrap(): void {
    if (this.config.value.app.nodeEnv === "test") return;
    void this.watcher.start();
  }
}

/**
 * The running watcher: the one trade feed of the deployment, and its
 * schedules (FeedMonitorService). The `copy` worker (its signal source and
 * the fast source's feed status) and the `all` worker import it; a `read`
 * worker uses WatcherModule's capabilities without a second feed.
 */
@Module({
  imports: [WatcherModule, NotifyModule],
  providers: [WatcherRuntime, FeedMonitorService],
  exports: [WatcherModule],
})
export class WatcherRuntimeModule {}
