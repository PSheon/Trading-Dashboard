DROP INDEX "copy_live_provenance_leg_uq";--> statement-breakpoint
CREATE INDEX "copy_live_provenance_leg_idx" ON "copy_live_intent_provenance" USING btree ("leg_id");