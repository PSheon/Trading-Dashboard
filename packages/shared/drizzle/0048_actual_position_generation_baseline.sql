CREATE TABLE "copy_live_position_baselines" (
	"mandate_id" text PRIMARY KEY NOT NULL,
	"first_execution_key" text NOT NULL,
	"account_id" text NOT NULL,
	"strategy_id" integer NOT NULL,
	"network" text NOT NULL,
	"account_address" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"source_digest" text NOT NULL,
	"snapshot_digest" text NOT NULL,
	"baseline_digest" text NOT NULL,
	"record" jsonb NOT NULL,
	"producer_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_baseline_identity_check" CHECK ("copy_live_position_baselines"."network" = 'testnet' and "copy_live_position_baselines"."account_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_position_baselines"."account_address" <> '0x0000000000000000000000000000000000000000' and "copy_live_position_baselines"."producer_version" = 1),
	CONSTRAINT "copy_live_baseline_evidence_check" CHECK ("copy_live_position_baselines"."source_digest" ~ '^[0-9a-f]{64}$' and "copy_live_position_baselines"."snapshot_digest" ~ '^[0-9a-f]{64}$' and "copy_live_position_baselines"."baseline_digest" ~ '^[0-9a-f]{64}$' and jsonb_typeof("copy_live_position_baselines"."record") = 'object'),
	CONSTRAINT "copy_live_baseline_time_check" CHECK (extract(epoch from "copy_live_position_baselines"."observed_at") > 0 and "copy_live_position_baselines"."completed_at" >= "copy_live_position_baselines"."observed_at" and "copy_live_position_baselines"."created_at" >= "copy_live_position_baselines"."completed_at" and "copy_live_position_baselines"."created_at" <= "copy_live_position_baselines"."observed_at" + interval '5 seconds')
);
--> statement-breakpoint
ALTER TABLE "copy_live_position_baselines" ADD CONSTRAINT "copy_live_position_baselines_mandate_id_copy_live_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."copy_live_mandates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_position_baselines" ADD CONSTRAINT "copy_live_position_baselines_first_execution_key_copy_live_executions_key_fk" FOREIGN KEY ("first_execution_key") REFERENCES "public"."copy_live_executions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_position_baselines" ADD CONSTRAINT "copy_live_position_baselines_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_position_baselines" ADD CONSTRAINT "copy_live_position_baselines_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_baseline_first_execution_uq" ON "copy_live_position_baselines" USING btree ("first_execution_key");