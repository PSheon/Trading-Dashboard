CREATE TABLE "archive_coverage" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"covered_from" timestamp with time zone,
	"covered_through" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "archive_coverage_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE "archive_ingest_state" (
	"chain" text PRIMARY KEY DEFAULT 'hyperliquid' NOT NULL,
	"live_next_hour" timestamp with time zone,
	"backfill_cursor_hour" timestamp with time zone,
	"objects" bigint DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"fills_seen" bigint DEFAULT 0 NOT NULL,
	"fills_kept" bigint DEFAULT 0 NOT NULL,
	"spend_day" text,
	"spend_day_bytes" bigint DEFAULT 0 NOT NULL,
	"last_object_key" text,
	"last_object_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_history_fills" ADD COLUMN "origin" text DEFAULT 'rest' NOT NULL;--> statement-breakpoint
CREATE INDEX "archive_coverage_from_idx" ON "archive_coverage" USING btree ("covered_from");--> statement-breakpoint
CREATE INDEX "archive_coverage_through_idx" ON "archive_coverage" USING btree ("covered_through");