CREATE TABLE "analysis_history_fills" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"source" text NOT NULL,
	"tid" bigint NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"raw" jsonb NOT NULL,
	CONSTRAINT "analysis_history_fills_chain_address_source_tid_pk" PRIMARY KEY("chain","address","source","tid")
);
--> statement-breakpoint
CREATE TABLE "analysis_history_jobs" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"published_through" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "analysis_history_jobs_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
ALTER TABLE "trader_analytics" ADD COLUMN "history_through" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "analysis_history_fills_address_time_idx" ON "analysis_history_fills" USING btree ("chain","address","time");--> statement-breakpoint
CREATE INDEX "analysis_history_jobs_attempted_idx" ON "analysis_history_jobs" USING btree ("status","attempted_at");