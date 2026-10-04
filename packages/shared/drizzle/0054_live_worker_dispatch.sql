CREATE TABLE "copy_live_activations" (
	"mandate_id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"control_revision" bigint NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "copy_live_activations_state_check" CHECK ("copy_live_activations"."state" in ('pending', 'activated') and "copy_live_activations"."control_revision" >= 0 and ("copy_live_activations"."state" = 'activated') = ("copy_live_activations"."activated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "copy_live_dispatches" (
	"id" text PRIMARY KEY NOT NULL,
	"mandate_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"source_fill_id" text NOT NULL,
	"leg" text NOT NULL,
	"coin" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"execution_key" text,
	"leader_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_live_dispatch_state_check" CHECK ("copy_live_dispatches"."state" in ('pending', 'submitted', 'settled', 'refused') and "copy_live_dispatches"."leg" in ('open','close') and "copy_live_dispatches"."attempts" >= 0 and ("copy_live_dispatches"."state" <> 'refused' or "copy_live_dispatches"."reason" is not null) and ("copy_live_dispatches"."state" not in ('submitted','settled') or "copy_live_dispatches"."execution_key" is not null) and ("copy_live_dispatches"."reason" is null or "copy_live_dispatches"."reason" ~ '^[a-z][a-z0-9_]{0,79}$'))
);
--> statement-breakpoint
ALTER TABLE "copy_live_activations" ADD CONSTRAINT "copy_live_activations_mandate_id_copy_live_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."copy_live_mandates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_activations" ADD CONSTRAINT "copy_live_activations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_activations" ADD CONSTRAINT "copy_live_activations_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_activations" ADD CONSTRAINT "copy_live_activations_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_dispatches" ADD CONSTRAINT "copy_live_dispatches_mandate_id_copy_live_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."copy_live_mandates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_dispatches" ADD CONSTRAINT "copy_live_dispatches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_dispatches" ADD CONSTRAINT "copy_live_dispatches_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_dispatches" ADD CONSTRAINT "copy_live_dispatches_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_dispatches" ADD CONSTRAINT "copy_live_dispatches_source_fill_id_copy_live_source_fills_id_fk" FOREIGN KEY ("source_fill_id") REFERENCES "public"."copy_live_source_fills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_dispatches" ADD CONSTRAINT "copy_live_dispatches_execution_key_copy_live_executions_key_fk" FOREIGN KEY ("execution_key") REFERENCES "public"."copy_live_executions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copy_live_activations_state_idx" ON "copy_live_activations" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_dispatch_leg_uq" ON "copy_live_dispatches" USING btree ("mandate_id","source_fill_id","leg");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_dispatch_execution_uq" ON "copy_live_dispatches" USING btree ("execution_key") WHERE "copy_live_dispatches"."execution_key" is not null;--> statement-breakpoint
CREATE INDEX "copy_live_dispatch_work_idx" ON "copy_live_dispatches" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "copy_live_dispatch_owner_idx" ON "copy_live_dispatches" USING btree ("user_id","created_at");