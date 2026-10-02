CREATE TABLE "retention_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"lease_token" text,
	"locked_until" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_status" text,
	"removed" jsonb,
	"cutoffs" jsonb,
	"last_error" text,
	"duration_ms" integer,
	CONSTRAINT "retention_state_single_row" CHECK ("retention_state"."id" = 1)
);
--> statement-breakpoint
CREATE INDEX "alerts_unsent_idx" ON "alerts" USING btree ("id") WHERE "alerts"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "equity_snapshots_ts_idx" ON "equity_snapshots" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "position_snapshots_ts_idx" ON "position_snapshots" USING btree ("ts");