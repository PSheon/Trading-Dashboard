CREATE TABLE "copy_follower_observation_budget" (
	"network" text PRIMARY KEY NOT NULL,
	"next_allowed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_follower_observation_budget_network_check" CHECK ("copy_follower_observation_budget"."network" = 'testnet')
);
--> statement-breakpoint
CREATE TABLE "copy_follower_observation_jobs" (
	"account_id" text PRIMARY KEY NOT NULL,
	"claim_token" text,
	"attempted_at" timestamp with time zone,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latest_observation_id" text,
	"issue" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_follower_observation_jobs_issue_check" CHECK ("copy_follower_observation_jobs"."issue" in ('source_unavailable', 'unsupported_mode', 'incomplete_coverage', 'invalid_evidence')),
	CONSTRAINT "copy_follower_observation_jobs_claim_check" CHECK (("copy_follower_observation_jobs"."claim_token" is null and "copy_follower_observation_jobs"."attempted_at" is null) or ("copy_follower_observation_jobs"."claim_token" is not null and "copy_follower_observation_jobs"."attempted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "copy_follower_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"network" text NOT NULL,
	"account_address" text NOT NULL,
	"source_digest" text NOT NULL,
	"producer_version" integer DEFAULT 1 NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"earliest_provider_time" timestamp with time zone NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_follower_observations_identity_check" CHECK ("copy_follower_observations"."network" = 'testnet' and "copy_follower_observations"."account_address" ~ '^0x[0-9a-f]{40}$' and "copy_follower_observations"."account_address" <> '0x0000000000000000000000000000000000000000' and "copy_follower_observations"."source_digest" ~ '^[0-9a-f]{64}$' and "copy_follower_observations"."producer_version" = 1 and jsonb_typeof("copy_follower_observations"."snapshot") = 'object'),
	CONSTRAINT "copy_follower_observations_time_check" CHECK ("copy_follower_observations"."completed_at" >= "copy_follower_observations"."observed_at" and "copy_follower_observations"."completed_at" <= "copy_follower_observations"."observed_at" + interval '5 seconds' and "copy_follower_observations"."earliest_provider_time" <= "copy_follower_observations"."completed_at" and "copy_follower_observations"."earliest_provider_time" >= "copy_follower_observations"."completed_at" - interval '5 seconds')
);
--> statement-breakpoint
ALTER TABLE "copy_follower_observation_jobs" ADD CONSTRAINT "copy_follower_observation_jobs_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_follower_observation_jobs" ADD CONSTRAINT "copy_follower_observation_jobs_latest_observation_id_copy_follower_observations_id_fk" FOREIGN KEY ("latest_observation_id") REFERENCES "public"."copy_follower_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_follower_observations" ADD CONSTRAINT "copy_follower_observations_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_follower_observations" ADD CONSTRAINT "copy_follower_observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_follower_observations" ADD CONSTRAINT "copy_follower_observations_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copy_follower_observation_jobs_due_idx" ON "copy_follower_observation_jobs" USING btree ("next_run_at","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_follower_observations_digest_uq" ON "copy_follower_observations" USING btree ("account_id","source_digest");--> statement-breakpoint
CREATE INDEX "copy_follower_observations_history_idx" ON "copy_follower_observations" USING btree ("account_id","observed_at","id");