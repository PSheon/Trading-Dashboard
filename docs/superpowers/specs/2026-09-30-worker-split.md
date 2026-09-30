# API / worker separation

User-approved objective: keep PostgreSQL, split continuous ingestion from HTTP API so API deploys do not restart ingestion; audit deployed Privy configuration.

Implementation: one shared Nest capability graph, explicit `APP_ROLE=api|worker|combined` (combined preserves local tooling). API disables schedules and all worker bootstrap hooks. Worker uses an application context with no business HTTP routes; its small private health server reports readiness and watcher heartbeat. API forwards heartbeat to the private worker URL with a bounded timeout. Worker holds a dedicated PostgreSQL advisory session lock before constructing the context; replacement workers remain standby until the previous owner exits. Losing the lock connection exits the worker.

Cross-process live feed: PostgreSQL LISTEN/NOTIFY carries only action IDs, not personal data. API loads feed rows through its existing service and applies stream authorization/filters. Listener reconnection closes streams so clients replay and refresh. Durable tables/outboxes remain authoritative; notifications are a low-latency hint, not a queue.

Stage rollout: same image, independent API and worker services, one worker replica, shared Stage PG. Keep Telegram dry-run. Split upstream request budgets between the two processes. Deploy role-aware API first, then worker; short monitoring downtime is explicit. No production changes. Verify local regressions, role isolation, PG event transport and singleton ownership, then deployed health/logs.

Privy audit: compare deployed public app ID with API app ID, use read-only authenticated app settings to check secret validity, verification-key correspondence, allowed origins and enabled methods. Do not print credentials or perform a real-user login. Record any inaccessible console-only settings as unverified.

Implementation review: shared module graph was retained to avoid duplicating capabilities; explicit role gates and disabled ScheduleModule discovery isolate continuous work. Added a commit-time per-address PG lock plus full analytics-state comparison after finding that the old in-memory serialization would not protect API/worker concurrent writers. Real-process smoke additionally terminates the lock connection and verifies fail-stop and standby takeover.
