CREATE TABLE "kol_avatars" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"source" text NOT NULL,
	"bytes" "bytea",
	"content_type" text,
	"etag" text,
	"fetched_at" timestamp with time zone,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "kol_avatars_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE INDEX "kol_avatars_next_idx" ON "kol_avatars" USING btree ("next_attempt_at");