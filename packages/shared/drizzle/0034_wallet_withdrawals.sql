CREATE TABLE "wallet_withdrawals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"network" text NOT NULL,
	"address" text NOT NULL,
	"destination" text NOT NULL,
	"amount" text NOT NULL,
	"nonce" bigint NOT NULL,
	"status" text NOT NULL,
	"origin" text NOT NULL,
	"claimed_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"evidence_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_withdrawals_network_check" CHECK ("wallet_withdrawals"."network" in ('testnet', 'mainnet')),
	CONSTRAINT "wallet_withdrawals_status_check" CHECK ("wallet_withdrawals"."status" in ('prepared', 'unknown', 'accepted', 'rejected', 'cancelled')),
	CONSTRAINT "wallet_withdrawals_origin_check" CHECK ("wallet_withdrawals"."origin" in ('client', 'legacy')),
	CONSTRAINT "wallet_withdrawals_evidence_check" CHECK ("wallet_withdrawals"."status" not in ('accepted', 'rejected') or ("wallet_withdrawals"."evidence_hash" is not null and "wallet_withdrawals"."evidence_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "wallet_withdrawals_attempt_check" CHECK ("wallet_withdrawals"."attempted_at" is null or ("wallet_withdrawals"."origin" = 'client' and "wallet_withdrawals"."claimed_at" is not null)),
	CONSTRAINT "wallet_withdrawals_identity_check" CHECK ("wallet_withdrawals"."address" ~ '^0x[0-9a-f]{40}$' and "wallet_withdrawals"."destination" ~ '^0x[0-9a-f]{40}$' and "wallet_withdrawals"."nonce" > 0 and "wallet_withdrawals"."nonce" <= 9007199254740991),
	CONSTRAINT "wallet_withdrawals_amount_check" CHECK ("wallet_withdrawals"."amount" ~ '^[0-9]+(\.[0-9]{1,6})?$' and length("wallet_withdrawals"."amount") <= 32 and "wallet_withdrawals"."amount"::numeric > 1 and "wallet_withdrawals"."amount"::numeric <= 1000000000000)
);
--> statement-breakpoint
ALTER TABLE "wallet_withdrawals" ADD CONSTRAINT "wallet_withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_withdrawals_nonce_uq" ON "wallet_withdrawals" USING btree ("network","address","nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_withdrawals_pending_uq" ON "wallet_withdrawals" USING btree ("network","address") WHERE "wallet_withdrawals"."status" in ('prepared', 'unknown');--> statement-breakpoint
CREATE INDEX "wallet_withdrawals_owner_idx" ON "wallet_withdrawals" USING btree ("user_id","network","nonce");