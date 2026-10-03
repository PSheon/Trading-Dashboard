ALTER TABLE "notification_outbox" ALTER COLUMN "action_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_events" ADD COLUMN "notification_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "copy_alerts_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "copy_alerts_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "copy_event_id" bigint;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_copy_event_id_copy_events_id_fk" FOREIGN KEY ("copy_event_id") REFERENCES "public"."copy_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_copy_event_user_uq" ON "notification_outbox" USING btree ("copy_event_id","user_id");--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_source_check" CHECK (("notification_outbox"."action_id" is not null) <> ("notification_outbox"."copy_event_id" is not null));