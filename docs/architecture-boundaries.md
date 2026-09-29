# Application boundaries

Controllers validate input and delegate use cases. Versioned HTTP output is
validated by the shared wire registry. Feature repositories contain owned queries
and persistence; they do not open hidden transactions or perform external calls.

SettingsService and FavoritesService own UnitOfWork.run boundaries and pass the
same transaction to all repository calls. Preserve the settings advisory lock,
user-row quota lock and leader-row lock. Backfill starts after commit. Existing
action/snapshot/outbox transactions remain intact; they must not be replaced by
independently committing repository methods.

Repositories now cover settings, favorites, alerts, legacy leaders and discovery
queries. Pure rule matching is separate from recipient/cooldown orchestration.
Other features retain their existing DB access; this is not a generic ORM wrapper
or a claim that every query has been relocated. Query batching is separate work.

IngestionModule supplies on-demand account/fill/backfill services without a
watcher bootstrap. UsersModule and ImportModule use this capability directly.
WatcherModule owns live feed orchestration. RulesService obtains equity through
the account-state reader; durable action context remains authoritative on replay.
TradersModule supplies discovery reads and explicit ingestion capabilities;
TradersWorkerModule owns automatic startup/cron bindings. AppModule intentionally
composes both API and workers for the supported single-replica deployment.
Health diagnostics still depend on runtime worker state; this change does not
introduce a separately deployable API-only process.

Shared package exports `/contracts` for browser-safe enums, schemas, permission
catalog and wire contracts, and `/database` for persistence tables. Frontend
sources and fixtures must never import the root compatibility barrel or database
entry. The legacy root export remains for external tooling compatibility. Domain
enums live in one ORM-free file used by both boundaries. Import paths changed,
not table definitions; no migration is required for this extraction.

Tests verify isolated feature initialization starts no watcher/network work and
check browser import boundaries. Existing real PostgreSQL rollback, overlap,
ownership and quota tests remain the semantic gate for repository changes.

RuntimeConfigModule supplies one deeply frozen AppConfig snapshot to production
providers. Startup validation runs before constructing the pool or workers;
configuration changes require a restart. Services use typed namespaces rather
than reading process.env. Pure action storage helpers receive the alert horizon
explicitly from ingestion services. Legacy env readers remain only for parser
regressions and injected test doubles; they are not production provider inputs.
