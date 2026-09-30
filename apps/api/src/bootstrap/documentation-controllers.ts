import { AdminController, PublicSettingsController } from "../admin/admin.controller.js";
import { ActionsController } from "../api/actions/actions.controller.js";
import { AlertRulesController } from "../api/alert-rules/alert-rules.controller.js";
import { AlertsController } from "../api/alerts/alerts.controller.js";
import { HealthController } from "../api/health/health.controller.js";
import { ReadinessController } from "../api/health/readiness.controller.js";
import { LeadersController } from "../api/leaders/leaders.controller.js";
import { ListsController } from "../api/lists/lists.controller.js";
import { AdminKolController, CopyScoreController, DiscoveryController } from "../discovery/discovery.controller.js";
import { ImportController } from "../import/import.controller.js";
import { InsightsController } from "../insights/insights.controller.js";
import { OutboxController } from "../outbox/outbox.controller.js";
import { TelegramController } from "../telegram/telegram.controller.js";
import { TradeAnalyticsController } from "../traders/trade-analytics.controller.js";
import { TradersController } from "../traders/traders.controller.js";
import { MeController } from "../users/me.controller.js";

/** Offline schema export only: controllers are instantiated with inert providers. */
export const documentationControllers = [AdminController, PublicSettingsController, ActionsController, AlertRulesController, AlertsController, HealthController, ReadinessController, LeadersController, ListsController, ImportController, InsightsController, OutboxController, TelegramController, TradeAnalyticsController, TradersController, MeController, DiscoveryController, CopyScoreController, AdminKolController];
