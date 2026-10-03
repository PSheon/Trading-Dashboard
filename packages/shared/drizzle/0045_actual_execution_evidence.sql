CREATE TABLE "copy_live_execution_evidence" (
	"key" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"network" text NOT NULL,
	"account_address" text NOT NULL,
	"cloid" text NOT NULL,
	"fingerprint" text NOT NULL,
	"nonce" bigint NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"exchange_order_id" text,
	"acknowledgement" jsonb,
	"acknowledgement_digest" text,
	"status_observation" jsonb,
	"status_digest" text,
	"settlement_certificate" jsonb,
	"settlement_digest" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_evidence_identity_check" CHECK ("copy_live_execution_evidence"."network" = 'testnet' and "copy_live_execution_evidence"."account_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_execution_evidence"."account_address" <> '0x0000000000000000000000000000000000000000' and "copy_live_execution_evidence"."cloid" ~ '^0x[0-9a-f]{32}$' and "copy_live_execution_evidence"."fingerprint" ~ '^[0-9a-f]{64}$' and "copy_live_execution_evidence"."nonce" > 0 and "copy_live_execution_evidence"."nonce" <= 9007199254740991 and "copy_live_execution_evidence"."revision" > 0 and ("copy_live_execution_evidence"."exchange_order_id" is null or ("copy_live_execution_evidence"."exchange_order_id" ~ '^[1-9][0-9]{0,19}$' and "copy_live_execution_evidence"."exchange_order_id"::numeric <= 18446744073709551615))),
	CONSTRAINT "copy_live_evidence_ack_check" CHECK (("copy_live_execution_evidence"."acknowledgement" is null and "copy_live_execution_evidence"."acknowledgement_digest" is null) or ("copy_live_execution_evidence"."acknowledgement" is not null and "copy_live_execution_evidence"."acknowledgement_digest" is not null and jsonb_typeof("copy_live_execution_evidence"."acknowledgement") = 'object' and "copy_live_execution_evidence"."acknowledgement_digest" ~ '^[0-9a-f]{64}$' and "copy_live_execution_evidence"."exchange_order_id" is not null)),
	CONSTRAINT "copy_live_evidence_status_check" CHECK (("copy_live_execution_evidence"."status_observation" is null and "copy_live_execution_evidence"."status_digest" is null) or ("copy_live_execution_evidence"."status_observation" is not null and "copy_live_execution_evidence"."status_digest" is not null and jsonb_typeof("copy_live_execution_evidence"."status_observation") = 'object' and "copy_live_execution_evidence"."status_digest" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "copy_live_evidence_settlement_check" CHECK (("copy_live_execution_evidence"."settlement_certificate" is null and "copy_live_execution_evidence"."settlement_digest" is null) or ("copy_live_execution_evidence"."settlement_certificate" is not null and "copy_live_execution_evidence"."settlement_digest" is not null and jsonb_typeof("copy_live_execution_evidence"."settlement_certificate") = 'object' and "copy_live_execution_evidence"."settlement_digest" ~ '^[0-9a-f]{64}$' and "copy_live_execution_evidence"."exchange_order_id" is not null)),
	CONSTRAINT "copy_live_evidence_time_check" CHECK ("copy_live_execution_evidence"."updated_at" >= "copy_live_execution_evidence"."created_at")
);
--> statement-breakpoint
ALTER TABLE "copy_live_execution_evidence" ADD CONSTRAINT "copy_live_execution_evidence_key_copy_live_executions_key_fk" FOREIGN KEY ("key") REFERENCES "public"."copy_live_executions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_execution_evidence" ADD CONSTRAINT "copy_live_execution_evidence_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_execution_evidence" ADD CONSTRAINT "copy_live_execution_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_execution_evidence" ADD CONSTRAINT "copy_live_execution_evidence_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_evidence_cloid_uq" ON "copy_live_execution_evidence" USING btree ("network","account_address","cloid");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_evidence_oid_uq" ON "copy_live_execution_evidence" USING btree ("network","account_address","exchange_order_id") WHERE "copy_live_execution_evidence"."exchange_order_id" is not null;--> statement-breakpoint
CREATE INDEX "copy_live_evidence_account_idx" ON "copy_live_execution_evidence" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE INDEX "copy_follower_receipts_order_idx" ON "copy_follower_receipts" USING btree ("account_id",("record"->>'oid')) WHERE "copy_follower_receipts"."kind" = 'fill';