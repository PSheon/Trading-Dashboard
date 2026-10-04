CREATE TABLE "hyperliquid_egress_quota" (
	"egress_key" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hyperliquid_quota_value_check" CHECK (length("hyperliquid_egress_quota"."egress_key") between 1 and 160 and "hyperliquid_egress_quota"."revision" > 0 and jsonb_typeof("hyperliquid_egress_quota"."events") = 'array' and jsonb_array_length("hyperliquid_egress_quota"."events") <= 4096)
);
--> statement-breakpoint
CREATE TABLE "hyperliquid_ws_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"egress_key" text NOT NULL,
	"socket_id" text NOT NULL,
	"fence_token" text NOT NULL,
	"owner_id" text NOT NULL,
	"state" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"latest_allowed_send_at" timestamp with time zone NOT NULL,
	"subscriptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "hyperliquid_ws_lease_check" CHECK (length("hyperliquid_ws_leases"."id") between 1 and 160 and length("hyperliquid_ws_leases"."socket_id") between 1 and 160 and length("hyperliquid_ws_leases"."owner_id") between 1 and 160 and "hyperliquid_ws_leases"."fence_token" ~ '^[0-9a-f]{64}$' and "hyperliquid_ws_leases"."revision" > 0 and "hyperliquid_ws_leases"."state" in ('reserved','open','closing','uncertain','closed') and jsonb_typeof("hyperliquid_ws_leases"."subscriptions") = 'array' and jsonb_array_length("hyperliquid_ws_leases"."subscriptions") <= 1000 and "hyperliquid_ws_leases"."lease_until" >= "hyperliquid_ws_leases"."created_at" and "hyperliquid_ws_leases"."latest_allowed_send_at" >= "hyperliquid_ws_leases"."created_at" and "hyperliquid_ws_leases"."updated_at" >= "hyperliquid_ws_leases"."created_at" and (("hyperliquid_ws_leases"."state" = 'closed' and "hyperliquid_ws_leases"."closed_at" is not null and "hyperliquid_ws_leases"."closed_at" >= "hyperliquid_ws_leases"."created_at" and jsonb_array_length("hyperliquid_ws_leases"."subscriptions") = 0) or ("hyperliquid_ws_leases"."state" <> 'closed' and "hyperliquid_ws_leases"."closed_at" is null)))
);
--> statement-breakpoint
ALTER TABLE "hyperliquid_ws_leases" ADD CONSTRAINT "hyperliquid_ws_leases_egress_key_hyperliquid_egress_quota_egress_key_fk" FOREIGN KEY ("egress_key") REFERENCES "public"."hyperliquid_egress_quota"("egress_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hyperliquid_ws_socket_uq" ON "hyperliquid_ws_leases" USING btree ("egress_key","socket_id");--> statement-breakpoint
CREATE INDEX "hyperliquid_ws_capacity_idx" ON "hyperliquid_ws_leases" USING btree ("egress_key","state");