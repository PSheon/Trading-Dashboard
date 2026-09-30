CREATE TABLE "backfill_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_attempts" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"fills_fetched" integer,
	"last_error_code" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "backfill_jobs_address_uq" ON "backfill_jobs" USING btree ("chain","address");--> statement-breakpoint
CREATE INDEX "backfill_jobs_pending_idx" ON "backfill_jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "backfill_jobs_lease_idx" ON "backfill_jobs" USING btree ("status","lease_expires_at");