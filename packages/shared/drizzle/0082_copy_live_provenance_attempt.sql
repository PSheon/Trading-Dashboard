ALTER TABLE "copy_live_intent_provenance" ADD COLUMN "attempt" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- A later attempt admitted between 0081 and this migration: its cloid is
-- liveSourceExecutionCloid(mandate, fill, leg, k) (copy-live-leg-attempt.ts),
-- sha256 of JSON ["live-copy-v1",mandate,fill,leg,k], first 32 hex digits.
-- Every other row is attempt 0 (the original derivation, without k).
UPDATE "copy_live_intent_provenance" p SET "attempt" = a.k
  FROM "copy_live_signal_legs" l, "copy_live_executions" e, (VALUES (1), (2)) AS a(k)
  WHERE l."id" = p."leg_id" AND e."key" = p."key"
    AND e."cloid" = '0x' || left(encode(sha256(convert_to('["live-copy-v1",' || to_json(l."mandate_id")::text || ',' || to_json(l."source_fill_id")::text || ','
      || to_json(l."leg")::text || ',' || a.k::text || ']', 'UTF8')), 'hex'), 32);--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_provenance_leg_attempt_uq" ON "copy_live_intent_provenance" USING btree ("leg_id","attempt");--> statement-breakpoint
ALTER TABLE "copy_live_intent_provenance" ADD CONSTRAINT "copy_live_provenance_attempt_check" CHECK ("copy_live_intent_provenance"."attempt" >= 0 and "copy_live_intent_provenance"."attempt" < 3);
