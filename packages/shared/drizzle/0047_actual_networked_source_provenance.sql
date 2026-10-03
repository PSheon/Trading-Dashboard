CREATE TABLE "copy_live_intent_provenance" (
	"key" text PRIMARY KEY NOT NULL,
	"leg_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"mandate_revision" integer NOT NULL,
	"source_digest" text NOT NULL,
	"settings_digest" text NOT NULL,
	"fingerprint" text NOT NULL,
	"planner_version" integer NOT NULL,
	"intent" jsonb NOT NULL,
	"sizing_basis" jsonb NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_provenance_evidence_check" CHECK ("copy_live_intent_provenance"."mandate_revision" > 0 and "copy_live_intent_provenance"."planner_version" = 1 and "copy_live_intent_provenance"."source_digest" ~ '^[0-9a-f]{64}$' and "copy_live_intent_provenance"."settings_digest" ~ '^[0-9a-f]{64}$' and "copy_live_intent_provenance"."fingerprint" ~ '^[0-9a-f]{64}$' and jsonb_typeof("copy_live_intent_provenance"."intent") = 'object' and jsonb_typeof("copy_live_intent_provenance"."sizing_basis") = 'object' and extract(epoch from "copy_live_intent_provenance"."admitted_at") > 0)
);
--> statement-breakpoint
CREATE TABLE "copy_live_reduction_carry" (
	"mandate_id" text NOT NULL,
	"coin" text NOT NULL,
	"carry" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_reduction_carry_mandate_id_coin_pk" PRIMARY KEY("mandate_id","coin"),
	CONSTRAINT "copy_live_carry_value_check" CHECK (length("copy_live_reduction_carry"."coin") between 1 and 129 and "copy_live_reduction_carry"."carry" ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$' and length("copy_live_reduction_carry"."carry") <= 80 and "copy_live_reduction_carry"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "copy_live_signal_legs" (
	"id" text PRIMARY KEY NOT NULL,
	"mandate_id" text NOT NULL,
	"source_fill_id" text NOT NULL,
	"leg" text NOT NULL,
	"trade_key" text NOT NULL,
	"fixed_trade_claim" boolean DEFAULT false NOT NULL,
	"sign" integer NOT NULL,
	"size" text NOT NULL,
	"fraction" text,
	"depends_on_id" text,
	"execution_key" text,
	"state" text DEFAULT 'planned' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_leg_generation_uq" UNIQUE("id","mandate_id"),
	CONSTRAINT "copy_live_leg_values_check" CHECK ("copy_live_signal_legs"."leg" in ('open','close') and "copy_live_signal_legs"."sign" in (-1,1) and "copy_live_signal_legs"."size" ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$' and length("copy_live_signal_legs"."size") <= 80 and "copy_live_signal_legs"."size"::numeric > 0 and "copy_live_signal_legs"."trade_key" ~ '^(oid|twap):[1-9][0-9]{0,19}$' and (("copy_live_signal_legs"."leg" = 'open' and "copy_live_signal_legs"."fraction" is null) or ("copy_live_signal_legs"."leg" = 'close' and not "copy_live_signal_legs"."fixed_trade_claim" and "copy_live_signal_legs"."fraction" is not null and "copy_live_signal_legs"."fraction" ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$' and length("copy_live_signal_legs"."fraction") <= 80 and "copy_live_signal_legs"."fraction"::numeric > 0 and "copy_live_signal_legs"."fraction"::numeric <= 1))),
	CONSTRAINT "copy_live_leg_state_check" CHECK ("copy_live_signal_legs"."state" in ('planned', 'prepared', 'settled', 'skipped', 'blocked') and ("copy_live_signal_legs"."state" not in ('prepared','settled') or "copy_live_signal_legs"."execution_key" is not null) and ("copy_live_signal_legs"."depends_on_id" is null or ("copy_live_signal_legs"."leg" = 'open' and "copy_live_signal_legs"."depends_on_id" <> "copy_live_signal_legs"."id")) and "copy_live_signal_legs"."revision" > 0 and "copy_live_signal_legs"."updated_at" >= "copy_live_signal_legs"."created_at")
);
--> statement-breakpoint
CREATE TABLE "copy_live_source_fills" (
	"id" text PRIMARY KEY NOT NULL,
	"stream_id" text NOT NULL,
	"network" text NOT NULL,
	"leader_address" text NOT NULL,
	"tid" text NOT NULL,
	"provider_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"coin" text NOT NULL,
	"oid" text NOT NULL,
	"trade_key" text NOT NULL,
	"px" text NOT NULL,
	"sz" text NOT NULL,
	"side" text NOT NULL,
	"start_position" text NOT NULL,
	"normalized" jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"source_digest" text NOT NULL,
	"origin_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "copy_live_source_fill_identity_check" CHECK ("copy_live_source_fills"."id" = "copy_live_source_fills"."network" || ':' || "copy_live_source_fills"."leader_address" || ':' || "copy_live_source_fills"."tid" and "copy_live_source_fills"."tid" ~ '^[1-9][0-9]{0,19}$' and "copy_live_source_fills"."tid"::numeric <= 18446744073709551615 and "copy_live_source_fills"."oid" ~ '^[1-9][0-9]{0,19}$' and "copy_live_source_fills"."oid"::numeric <= 18446744073709551615 and "copy_live_source_fills"."trade_key" ~ '^(oid|twap):[1-9][0-9]{0,19}$' and length("copy_live_source_fills"."coin") between 1 and 129 and "copy_live_source_fills"."origin_version" = 1),
	CONSTRAINT "copy_live_source_fill_values_check" CHECK ("copy_live_source_fills"."side" in ('B','A') and "copy_live_source_fills"."px" ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$' and length("copy_live_source_fills"."px") <= 80 and "copy_live_source_fills"."px"::numeric > 0 and "copy_live_source_fills"."sz" ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$' and length("copy_live_source_fills"."sz") <= 80 and "copy_live_source_fills"."sz"::numeric > 0 and "copy_live_source_fills"."start_position" ~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,18})?$' and length("copy_live_source_fills"."start_position") <= 81),
	CONSTRAINT "copy_live_source_fill_evidence_check" CHECK ("copy_live_source_fills"."source_digest" ~ '^[0-9a-f]{64}$' and jsonb_typeof("copy_live_source_fills"."normalized") = 'object' and jsonb_typeof("copy_live_source_fills"."raw") = 'object' and "copy_live_source_fills"."provider_time" <= "copy_live_source_fills"."received_at" and extract(epoch from "copy_live_source_fills"."provider_time") > 0)
);
--> statement-breakpoint
CREATE TABLE "copy_live_source_streams" (
	"id" text PRIMARY KEY NOT NULL,
	"network" text NOT NULL,
	"leader_address" text NOT NULL,
	"state" text DEFAULT 'unproven' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"coverage_from" timestamp with time zone,
	"coverage_through" timestamp with time zone,
	"coverage_digest" text,
	"last_issue" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_live_stream_binding_uq" UNIQUE("id","network","leader_address"),
	CONSTRAINT "copy_live_stream_identity_check" CHECK ("copy_live_source_streams"."network" in ('testnet','mainnet') and "copy_live_source_streams"."leader_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_source_streams"."leader_address" <> '0x0000000000000000000000000000000000000000' and "copy_live_source_streams"."id" = "copy_live_source_streams"."network" || ':' || "copy_live_source_streams"."leader_address" and "copy_live_source_streams"."revision" > 0),
	CONSTRAINT "copy_live_stream_state_check" CHECK ("copy_live_source_streams"."state" in ('unproven', 'ready', 'gap', 'quarantined')),
	CONSTRAINT "copy_live_stream_coverage_check" CHECK (("copy_live_source_streams"."coverage_from" is null and "copy_live_source_streams"."coverage_through" is null and "copy_live_source_streams"."coverage_digest" is null and "copy_live_source_streams"."state" <> 'ready') or ("copy_live_source_streams"."coverage_from" is not null and "copy_live_source_streams"."coverage_through" is not null and "copy_live_source_streams"."coverage_digest" is not null and "copy_live_source_streams"."coverage_from" <= "copy_live_source_streams"."coverage_through" and "copy_live_source_streams"."coverage_digest" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "copy_live_stream_issue_check" CHECK ("copy_live_source_streams"."last_issue" is null or "copy_live_source_streams"."last_issue" in ('source_unavailable', 'incomplete_coverage', 'duplicate_conflict', 'invalid_fill', 'cursor_regression'))
);
--> statement-breakpoint
ALTER TABLE "copy_live_intent_provenance" ADD CONSTRAINT "copy_live_intent_provenance_key_copy_live_executions_key_fk" FOREIGN KEY ("key") REFERENCES "public"."copy_live_executions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_intent_provenance" ADD CONSTRAINT "copy_live_intent_provenance_leg_id_mandate_id_copy_live_signal_legs_id_mandate_id_fk" FOREIGN KEY ("leg_id","mandate_id") REFERENCES "public"."copy_live_signal_legs"("id","mandate_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_reduction_carry" ADD CONSTRAINT "copy_live_reduction_carry_mandate_id_copy_live_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."copy_live_mandates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_signal_legs" ADD CONSTRAINT "copy_live_signal_legs_mandate_id_copy_live_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."copy_live_mandates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_signal_legs" ADD CONSTRAINT "copy_live_signal_legs_source_fill_id_copy_live_source_fills_id_fk" FOREIGN KEY ("source_fill_id") REFERENCES "public"."copy_live_source_fills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_signal_legs" ADD CONSTRAINT "copy_live_signal_legs_depends_on_id_copy_live_signal_legs_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."copy_live_signal_legs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_signal_legs" ADD CONSTRAINT "copy_live_signal_legs_execution_key_copy_live_executions_key_fk" FOREIGN KEY ("execution_key") REFERENCES "public"."copy_live_executions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_source_fills" ADD CONSTRAINT "copy_live_source_fills_stream_id_network_leader_address_copy_live_source_streams_id_network_leader_address_fk" FOREIGN KEY ("stream_id","network","leader_address") REFERENCES "public"."copy_live_source_streams"("id","network","leader_address") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_provenance_leg_uq" ON "copy_live_intent_provenance" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX "copy_live_provenance_admission_idx" ON "copy_live_intent_provenance" USING btree ("mandate_id","admitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_leg_fill_uq" ON "copy_live_signal_legs" USING btree ("mandate_id","source_fill_id","leg");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_leg_fixed_trade_uq" ON "copy_live_signal_legs" USING btree ("mandate_id","trade_key") WHERE "copy_live_signal_legs"."leg" = 'open' and "copy_live_signal_legs"."fixed_trade_claim";--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_leg_execution_uq" ON "copy_live_signal_legs" USING btree ("execution_key") WHERE "copy_live_signal_legs"."execution_key" is not null;--> statement-breakpoint
CREATE INDEX "copy_live_leg_work_idx" ON "copy_live_signal_legs" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_source_fill_tid_uq" ON "copy_live_source_fills" USING btree ("stream_id","tid");--> statement-breakpoint
CREATE INDEX "copy_live_source_fill_time_idx" ON "copy_live_source_fills" USING btree ("stream_id","provider_time","tid");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_stream_identity_uq" ON "copy_live_source_streams" USING btree ("network","leader_address");