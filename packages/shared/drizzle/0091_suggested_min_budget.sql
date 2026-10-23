-- Suggested minimum budget per leader (decision D7, 2026-10-23): suggested = ceil(10 × leader perp equity ÷ median
-- notional of the leader's position-increasing orders over the last 30 days), whole USD, recomputed hourly by the read
-- worker for every watched, copied or pool leader (apps/api/src/traders/suggested-budget.repository.ts). Its own small
-- table: trader_stats rows are rewritten and deleted by the leaderboard import, discovery_traders rows by the pool
-- build, and neither covers every copyable leader. New and empty: no lock on any existing table; the first hourly
-- run fills it.
-- Rollback: DROP TABLE "trader_suggested_budgets" (the previous release never reads it).
CREATE TABLE "trader_suggested_budgets" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"suggested_min_budget_usd" integer,
	"adds" integer NOT NULL,
	"median_add_notional_usd" numeric,
	"leader_perp_equity_usd" numeric,
	"window_from" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trader_suggested_budgets_chain_address_pk" PRIMARY KEY("chain","address")
);
