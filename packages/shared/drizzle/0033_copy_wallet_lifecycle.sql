CREATE TABLE "copy_execution_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"network" text NOT NULL,
	"privy_user_id" text NOT NULL,
	"external_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"privy_wallet_id" text,
	"owner_quorum_id" text,
	"address" text,
	"issue" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_execution_accounts_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "copy_execution_accounts_privy_wallet_id_unique" UNIQUE("privy_wallet_id"),
	CONSTRAINT "copy_execution_accounts_address_unique" UNIQUE("address"),
	CONSTRAINT "copy_execution_accounts_network_check" CHECK ("copy_execution_accounts"."network" in ('testnet', 'mainnet')),
	CONSTRAINT "copy_execution_accounts_state_check" CHECK ("copy_execution_accounts"."state" in ('requested', 'unknown', 'ready', 'blocked')),
	CONSTRAINT "copy_execution_accounts_revision_check" CHECK ("copy_execution_accounts"."revision" >= 1),
	CONSTRAINT "copy_execution_accounts_issue_check" CHECK ("copy_execution_accounts"."issue" in ('verification_pending', 'provider_unavailable', 'wallet_conflict')),
	CONSTRAINT "copy_execution_accounts_ready_check" CHECK ("copy_execution_accounts"."state" <> 'ready' or ("copy_execution_accounts"."privy_wallet_id" is not null and "copy_execution_accounts"."owner_quorum_id" is not null and "copy_execution_accounts"."address" is not null and "copy_execution_accounts"."address" ~ '^0x[0-9a-f]{40}$' and "copy_execution_accounts"."issue" is null))
);
--> statement-breakpoint
CREATE TABLE "copy_wallet_authorization_events" (
	"id" text PRIMARY KEY NOT NULL,
	"authorization_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_wallet_authorization_events_action_check" CHECK ("copy_wallet_authorization_events"."action" = 'revoked' and "copy_wallet_authorization_events"."version" >= 2)
);
--> statement-breakpoint
ALTER TABLE "copy_execution_accounts" ADD CONSTRAINT "copy_execution_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_execution_accounts" ADD CONSTRAINT "copy_execution_accounts_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_wallet_authorization_events" ADD CONSTRAINT "copy_wallet_authorization_events_authorization_id_copy_wallet_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."copy_wallet_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_wallet_authorization_events" ADD CONSTRAINT "copy_wallet_authorization_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_execution_accounts_strategy_uq" ON "copy_execution_accounts" USING btree ("network","strategy_id");--> statement-breakpoint
CREATE INDEX "copy_execution_accounts_owner_idx" ON "copy_execution_accounts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_wallet_authorization_events_version_uq" ON "copy_wallet_authorization_events" USING btree ("authorization_id","version");