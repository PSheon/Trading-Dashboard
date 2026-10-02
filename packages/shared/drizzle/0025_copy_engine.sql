ALTER TABLE "copy_orders" ADD COLUMN "trade_key" text;--> statement-breakpoint
ALTER TABLE "copy_orders" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_orders" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "copy_positions" ADD COLUMN "reduce_carry" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE INDEX "copy_orders_trade_key_idx" ON "copy_orders" USING btree ("strategy_id","trade_key") WHERE "copy_orders"."trade_key" is not null;