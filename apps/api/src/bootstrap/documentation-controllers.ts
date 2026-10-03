import { AdminCopyController } from "../admin/admin-copy.controller.js";
import { AdminSourcesController } from "../admin/admin-sources.controller.js";
import { AdminTraderController } from "../admin/admin-trader.controller.js";
import { FavoriteGroupsController } from "../users/favorite-groups.controller.js";
import { TraderSearchController } from "../traders/trader-search.controller.js";
import { AdminAuditController } from "../admin/admin-audit.controller.js";
import { AdminSettingsRuntimeController } from "../admin/admin-settings-runtime.controller.js";
import { AdminJobsController } from "../admin/admin-jobs.controller.js";
import { AdminSystemController } from "../admin/admin-system.controller.js";
import { AdminController, PublicSettingsController } from "../admin/admin.controller.js";
import { ActionsController } from "../api/actions/actions.controller.js";
import { AlertRulesController } from "../api/alert-rules/alert-rules.controller.js";
import { AlertsController } from "../api/alerts/alerts.controller.js";
import { AdminHeartbeatController, HealthController } from "../api/health/health.controller.js";
import { ReadinessController } from "../api/health/readiness.controller.js";
import { LeadersController } from "../api/leaders/leaders.controller.js";
import { ListsController } from "../api/lists/lists.controller.js";
import { AdminKolController, CopyScoreController, DiscoveryController, KolAvatarController } from "../discovery/discovery.controller.js";
import { ImportController } from "../import/import.controller.js";
import { InsightsController } from "../insights/insights.controller.js";
import { OutboxController } from "../outbox/outbox.controller.js";
import { TelegramController } from "../telegram/telegram.controller.js";
import { TradeAnalyticsController } from "../traders/trade-analytics.controller.js";
import { TradersController } from "../traders/traders.controller.js";
import { MeController } from "../users/me.controller.js";
import { WalletController } from "../wallet/wallet.controller.js";
import { WithdrawalController } from "../wallet/withdrawal.controller.js";
import { CopyController } from "../copy/copy.controller.js";
import { CopyWalletController } from "../copy/copy-wallet.controller.js";
import { CopyFundingController } from "../copy/copy-funding.controller.js";
import { CopyAgentController } from "../copy/copy-agent.controller.js";
import { CopyAccountModeController } from "../copy/copy-account-mode.controller.js";
import { CopyFollowerController } from "../copy/copy-follower.controller.js";

/** Offline schema export only: controllers are instantiated with inert providers. */
export const documentationControllers = [AdminSourcesController, AdminTraderController, FavoriteGroupsController, TraderSearchController, AdminAuditController, AdminSettingsRuntimeController,
  AdminJobsController, AdminSystemController, AdminController, PublicSettingsController, ActionsController, AlertRulesController, AlertsController, HealthController, AdminHeartbeatController, ReadinessController, LeadersController, ListsController, ImportController, InsightsController, OutboxController, TelegramController, TradeAnalyticsController, TradersController, MeController, DiscoveryController, CopyScoreController, AdminKolController, KolAvatarController, WalletController, WithdrawalController, CopyController, CopyWalletController, CopyFundingController, CopyAgentController, CopyAccountModeController, CopyFollowerController, AdminCopyController];
