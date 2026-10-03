CREATE TABLE "copy_account_mode_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"strategy_id" integer NOT NULL,
	"network" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"account_address" text NOT NULL,
	"account_wallet_id" text NOT NULL,
	"account_owner_quorum_id" text NOT NULL,
	"owner_privy_user_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"target" text DEFAULT 'disabled' NOT NULL,
	"submission_state" text DEFAULT 'prepared' NOT NULL,
	"target_state" text DEFAULT 'unknown' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"nonce" bigint,
	"consent_expires_at" timestamp with time zone,
	"intent" jsonb,
	"intent_digest" text,
	"consent_digest" text,
	"claim_token" text,
	"signing_started_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"attempt_proof" jsonb,
	"acknowledgment_digest" text,
	"observation" jsonb,
	"observed_at" timestamp with time zone,
	"issue" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_account_modes_states_check" CHECK ("copy_account_mode_operations"."network" = 'testnet' and "copy_account_mode_operations"."target" = 'disabled' and "copy_account_mode_operations"."revision" >= 1),
	CONSTRAINT "copy_account_modes_submission_check" CHECK ("copy_account_mode_operations"."submission_state" in ('prepared', 'signing', 'unknown', 'accepted', 'rejected')),
	CONSTRAINT "copy_account_modes_target_check" CHECK ("copy_account_mode_operations"."target_state" in ('unknown', 'supported', 'unproven', 'unsupported')),
	CONSTRAINT "copy_account_modes_identity_check" CHECK ("copy_account_mode_operations"."account_address" ~ '^0x[0-9a-f]{40}$' and "copy_account_mode_operations"."account_address" <> '0x0000000000000000000000000000000000000000' and "copy_account_mode_operations"."owner_address" ~ '^0x[0-9a-f]{40}$' and "copy_account_mode_operations"."account_address" <> "copy_account_mode_operations"."owner_address"),
	CONSTRAINT "copy_account_modes_nonce_check" CHECK (("copy_account_mode_operations"."nonce" is null and "copy_account_mode_operations"."consent_expires_at" is null and "copy_account_mode_operations"."intent" is null and "copy_account_mode_operations"."intent_digest" is null) or ("copy_account_mode_operations"."nonce" is not null and "copy_account_mode_operations"."nonce" > 0 and "copy_account_mode_operations"."nonce" <= 9007199254740991 and "copy_account_mode_operations"."consent_expires_at" is not null and extract(epoch from "copy_account_mode_operations"."consent_expires_at") * 1000 > "copy_account_mode_operations"."nonce" and extract(epoch from "copy_account_mode_operations"."consent_expires_at") * 1000 <= "copy_account_mode_operations"."nonce" + 300000 and "copy_account_mode_operations"."intent" is not null and "copy_account_mode_operations"."intent_digest" is not null and "copy_account_mode_operations"."intent_digest" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "copy_account_modes_signing_check" CHECK ("copy_account_mode_operations"."submission_state" <> 'signing' or ("copy_account_mode_operations"."claim_token" is not null and "copy_account_mode_operations"."signing_started_at" is not null and "copy_account_mode_operations"."consent_digest" is not null and "copy_account_mode_operations"."consent_digest" ~ '^[0-9a-f]{64}$' and "copy_account_mode_operations"."nonce" is not null)),
	CONSTRAINT "copy_account_modes_attempt_check" CHECK (("copy_account_mode_operations"."attempted_at" is null and "copy_account_mode_operations"."submission_state" in ('prepared', 'signing')) or ("copy_account_mode_operations"."attempted_at" is not null and "copy_account_mode_operations"."submission_state" in ('unknown', 'accepted', 'rejected') and "copy_account_mode_operations"."nonce" is not null and "copy_account_mode_operations"."intent" is not null and "copy_account_mode_operations"."consent_digest" is not null and "copy_account_mode_operations"."consent_digest" ~ '^[0-9a-f]{64}$' and "copy_account_mode_operations"."attempt_proof" is not null)),
	CONSTRAINT "copy_account_modes_ack_check" CHECK ("copy_account_mode_operations"."submission_state" not in ('accepted', 'rejected') or ("copy_account_mode_operations"."acknowledgment_digest" is not null and "copy_account_mode_operations"."acknowledgment_digest" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "copy_account_modes_observed_check" CHECK ("copy_account_mode_operations"."target_state" <> 'supported' or ("copy_account_mode_operations"."observation" is not null and "copy_account_mode_operations"."observed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "copy_account_mode_operations" ADD CONSTRAINT "copy_account_mode_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_account_mode_operations" ADD CONSTRAINT "copy_account_mode_operations_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_account_mode_operations" ADD CONSTRAINT "copy_account_mode_operations_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_account_modes_key_uq" ON "copy_account_mode_operations" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_account_modes_account_uq" ON "copy_account_mode_operations" USING btree ("network","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_account_modes_nonce_uq" ON "copy_account_mode_operations" USING btree ("network","account_address","nonce");--> statement-breakpoint
CREATE INDEX "copy_account_modes_owner_idx" ON "copy_account_mode_operations" USING btree ("user_id","created_at");