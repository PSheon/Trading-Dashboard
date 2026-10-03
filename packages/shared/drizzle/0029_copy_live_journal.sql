CREATE TABLE "copy_execution_wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"network" text NOT NULL,
	"account_address" text NOT NULL,
	"privy_wallet_id" text NOT NULL,
	"privy_owner_id" text NOT NULL,
	"signer_address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_execution_wallets_network_check" CHECK ("copy_execution_wallets"."network" in ('testnet', 'mainnet'))
);
--> statement-breakpoint
CREATE TABLE "copy_live_executions" (
	"key" text PRIMARY KEY NOT NULL,
	"network" text NOT NULL,
	"account_address" text NOT NULL,
	"signer_address" text NOT NULL,
	"cloid" text NOT NULL,
	"nonce" bigint NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"state" text NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_executions_network_check" CHECK ("copy_live_executions"."network" in ('testnet', 'mainnet')),
	CONSTRAINT "copy_live_executions_state_check" CHECK ("copy_live_executions"."state" in ('prepared', 'submitting', 'unknown', 'resting', 'filled', 'partial', 'cancelled', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "copy_signer_nonces" (
	"network" text NOT NULL,
	"signer_address" text NOT NULL,
	"nonce" bigint NOT NULL,
	CONSTRAINT "copy_signer_nonces_network_signer_address_pk" PRIMARY KEY("network","signer_address"),
	CONSTRAINT "copy_signer_nonces_network_check" CHECK ("copy_signer_nonces"."network" in ('testnet', 'mainnet')),
	CONSTRAINT "copy_signer_nonces_value_check" CHECK ("copy_signer_nonces"."nonce" >= 0 and "copy_signer_nonces"."nonce" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "copy_wallet_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"version" integer NOT NULL,
	"scopes" jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"exchange_approved_at" timestamp with time zone,
	CONSTRAINT "copy_wallet_authorizations_version_check" CHECK ("copy_wallet_authorizations"."version" >= 1 and "copy_wallet_authorizations"."expires_at" > "copy_wallet_authorizations"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "copy_execution_wallets" ADD CONSTRAINT "copy_execution_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_executions" ADD CONSTRAINT "copy_live_executions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_wallet_authorizations" ADD CONSTRAINT "copy_wallet_authorizations_wallet_id_copy_execution_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."copy_execution_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_execution_wallets_account_uq" ON "copy_execution_wallets" USING btree ("network","account_address");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_execution_wallets_strategy_uq" ON "copy_execution_wallets" USING btree ("network","strategy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_executions_nonce_uq" ON "copy_live_executions" USING btree ("network","signer_address","nonce");--> statement-breakpoint
CREATE INDEX "copy_live_executions_owner_idx" ON "copy_live_executions" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "copy_live_executions_recovery_idx" ON "copy_live_executions" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "copy_wallet_authorizations_wallet_idx" ON "copy_wallet_authorizations" USING btree ("wallet_id");