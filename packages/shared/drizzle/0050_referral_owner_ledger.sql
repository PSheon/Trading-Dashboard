CREATE TABLE "referral_attributions" (
	"id" text PRIMARY KEY NOT NULL,
	"referred_user_id" integer NOT NULL,
	"referrer_user_id" integer NOT NULL,
	"code_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"bound_at" timestamp with time zone NOT NULL,
	CONSTRAINT "referral_no_self_check" CHECK ("referral_attributions"."referred_user_id" <> "referral_attributions"."referrer_user_id")
);
--> statement-breakpoint
CREATE TABLE "referral_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"network" text NOT NULL,
	"token" text NOT NULL,
	"destination" text NOT NULL,
	"amount_units" text NOT NULL,
	"status" text NOT NULL,
	"attempt_id" text,
	"settlement_hash" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "referral_claim_value_check" CHECK (length("referral_claims"."key") between 8 and 120 and "referral_claims"."request_hash" ~ '^[0-9a-f]{64}$' and "referral_claims"."network" = 'mainnet' and "referral_claims"."token" = 'USDC' and "referral_claims"."destination" ~ '^0x[0-9a-f]{40}$' and "referral_claims"."destination" <> '0x0000000000000000000000000000000000000000' and "referral_claims"."amount_units" ~ '^[1-9][0-9]{0,38}$' and "referral_claims"."status" in ('requested','approved','sending','unknown','paid','rejected','failed') and ("referral_claims"."attempt_id" is null or length("referral_claims"."attempt_id") between 1 and 120) and ("referral_claims"."settlement_hash" is null or "referral_claims"."settlement_hash" ~ '^[0-9a-f]{64}$') and "referral_claims"."updated_at" >= "referral_claims"."created_at" and ("referral_claims"."status" not in ('sending','unknown','paid') or "referral_claims"."attempt_id" is not null) and ("referral_claims"."status" <> 'paid' or "referral_claims"."settlement_hash" is not null))
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_code_value_check" CHECK ("referral_codes"."code" ~ '^[A-Z0-9]{3,16}$' and "referral_codes"."kind" in ('default','custom'))
);
--> statement-breakpoint
CREATE TABLE "referral_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"event_id" text NOT NULL,
	"bucket" text NOT NULL,
	"amount_units" text NOT NULL,
	"claim_id" text,
	"receipt_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "referral_ledger_value_check" CHECK (length("referral_ledger"."event_id") between 1 and 200 and "referral_ledger"."bucket" in ('earned','available','pending','claimed') and "referral_ledger"."amount_units" ~ '^-?(0|[1-9][0-9]{0,38})$' and "referral_ledger"."amount_units" <> '-0')
);
--> statement-breakpoint
CREATE TABLE "referral_policies" (
	"version" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"reward_bps" integer,
	"min_claim_units" text,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"token" text DEFAULT 'USDC' NOT NULL,
	"treasury_address" text,
	"bind_window_seconds" integer DEFAULT 1800 NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_policy_value_check" CHECK (length("referral_policies"."version") between 1 and 100 and "referral_policies"."network" = 'mainnet' and "referral_policies"."token" = 'USDC' and ("referral_policies"."reward_bps" is null or "referral_policies"."reward_bps" between 0 and 10000) and ("referral_policies"."min_claim_units" is null or ("referral_policies"."min_claim_units" ~ '^[1-9][0-9]{0,38}$')) and ("referral_policies"."treasury_address" is null or ("referral_policies"."treasury_address" ~ '^0x[0-9a-f]{40}$' and "referral_policies"."treasury_address" <> '0x0000000000000000000000000000000000000000')) and "referral_policies"."bind_window_seconds" between 1 and 2592000 and ("referral_policies"."effective_until" is null or "referral_policies"."effective_until" > "referral_policies"."effective_from") and (not "referral_policies"."enabled" or ("referral_policies"."reward_bps" is not null and "referral_policies"."min_claim_units" is not null and "referral_policies"."treasury_address" is not null)))
);
--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_referred_user_id_users_id_fk" FOREIGN KEY ("referred_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_code_id_referral_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."referral_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_policy_version_referral_policies_version_fk" FOREIGN KEY ("policy_version") REFERENCES "public"."referral_policies"("version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_claims" ADD CONSTRAINT "referral_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_claims" ADD CONSTRAINT "referral_claims_policy_version_referral_policies_version_fk" FOREIGN KEY ("policy_version") REFERENCES "public"."referral_policies"("version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_ledger" ADD CONSTRAINT "referral_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_ledger" ADD CONSTRAINT "referral_ledger_claim_id_referral_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."referral_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_referred_user_uq" ON "referral_attributions" USING btree ("referred_user_id");--> statement-breakpoint
CREATE INDEX "referral_friends_idx" ON "referral_attributions" USING btree ("referrer_user_id","bound_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_claim_owner_key_uq" ON "referral_claims" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "referral_claim_history_idx" ON "referral_claims" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_claim_open_uq" ON "referral_claims" USING btree ("user_id","network","token") WHERE "referral_claims"."status" in ('requested','approved','sending','unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "referral_code_uq" ON "referral_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_current_code_uq" ON "referral_codes" USING btree ("user_id") WHERE "referral_codes"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "referral_ledger_event_bucket_uq" ON "referral_ledger" USING btree ("event_id","bucket","user_id");--> statement-breakpoint
CREATE INDEX "referral_ledger_owner_idx" ON "referral_ledger" USING btree ("user_id","created_at");