CREATE TABLE "copy_live_stop_cancellations" (
	"id" text PRIMARY KEY NOT NULL,
	"stop_id" text NOT NULL,
	"execution_key" text NOT NULL,
	"attempt" integer NOT NULL,
	"state" text DEFAULT 'claimed' NOT NULL,
	"claim_token" text NOT NULL,
	"nonce" bigint NOT NULL,
	"expires_after" bigint NOT NULL,
	"consent_digest" text NOT NULL,
	"evidence" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_stop_cancellations_check" CHECK ("copy_live_stop_cancellations"."state" in ('claimed', 'accepted', 'unknown') and "copy_live_stop_cancellations"."attempt" between 1 and 10 and "copy_live_stop_cancellations"."nonce" > 0 and "copy_live_stop_cancellations"."expires_after" > "copy_live_stop_cancellations"."nonce" and "copy_live_stop_cancellations"."consent_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "copy_live_stop_consents" (
	"stop_id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"intent" jsonb NOT NULL,
	"intent_digest" text NOT NULL,
	"consent_digest" text,
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_stop_consents_check" CHECK (jsonb_typeof("copy_live_stop_consents"."intent") = 'object' and "copy_live_stop_consents"."intent_digest" ~ '^[0-9a-f]{64}$' and ("copy_live_stop_consents"."consent_digest" is null) = ("copy_live_stop_consents"."verified_at" is null) and ("copy_live_stop_consents"."consent_digest" is null or "copy_live_stop_consents"."consent_digest" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "copy_live_risk_reservations" DROP CONSTRAINT "copy_live_risk_reservations_release_check";--> statement-breakpoint
ALTER TABLE "copy_live_stop_cancellations" ADD CONSTRAINT "copy_live_stop_cancellations_stop_id_copy_live_stop_operations_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."copy_live_stop_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_stop_cancellations" ADD CONSTRAINT "copy_live_stop_cancellations_execution_key_copy_live_executions_key_fk" FOREIGN KEY ("execution_key") REFERENCES "public"."copy_live_executions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_stop_consents" ADD CONSTRAINT "copy_live_stop_consents_stop_id_copy_live_stop_operations_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."copy_live_stop_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_stop_consents" ADD CONSTRAINT "copy_live_stop_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_stop_cancellations_attempt_uq" ON "copy_live_stop_cancellations" USING btree ("stop_id","execution_key","attempt");--> statement-breakpoint
ALTER TABLE "copy_live_risk_reservations" ADD CONSTRAINT "copy_live_risk_reservations_release_check" CHECK (("copy_live_risk_reservations"."state" <> 'released' and "copy_live_risk_reservations"."release_reason" is null and "copy_live_risk_reservations"."release_evidence_digest" is null) or ("copy_live_risk_reservations"."state" = 'released' and "copy_live_risk_reservations"."release_reason" is not null and "copy_live_risk_reservations"."release_evidence_digest" is not null and "copy_live_risk_reservations"."release_evidence_digest" ~ '^[0-9a-f]{64}$' and (("copy_live_risk_reservations"."release_reason" = 'unattempted_expired' and "copy_live_risk_reservations"."attempted_at" is null and "copy_live_risk_reservations"."exchange_order_id" is null) or ("copy_live_risk_reservations"."release_reason" = 'verified_settlement' and "copy_live_risk_reservations"."attempted_at" is not null) or ("copy_live_risk_reservations"."release_reason" = 'expired_unplaced' and "copy_live_risk_reservations"."attempted_at" is not null and "copy_live_risk_reservations"."exchange_order_id" is null))));