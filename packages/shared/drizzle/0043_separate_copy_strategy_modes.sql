ALTER TABLE "copy_strategies" DROP CONSTRAINT "copy_strategies_mode_check";--> statement-breakpoint
ALTER TABLE "copy_strategies" DROP CONSTRAINT "copy_strategies_amounts_check";--> statement-breakpoint
DROP INDEX "copy_strategies_live_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "copy_strategies_live_uq" ON "copy_strategies" USING btree ("user_id","chain","leader_address","mode") WHERE status <> 'stopped';--> statement-breakpoint
ALTER TABLE "copy_strategies" ADD CONSTRAINT "copy_strategies_mode_check" CHECK ("copy_strategies"."mode" in ('paper', 'testnet'));--> statement-breakpoint
ALTER TABLE "copy_strategies" ADD CONSTRAINT "copy_strategies_amounts_check" CHECK ("copy_strategies"."version" >= 1 and "copy_strategies"."control_revision" >= 0 and
    (("copy_strategies"."mode" = 'paper' and "copy_strategies"."allocated" > 0 and "copy_strategies"."withdrawn" >= 0 and "copy_strategies"."fees" >= 0) or
     ("copy_strategies"."mode" = 'testnet' and "copy_strategies"."allocated" = 0 and "copy_strategies"."cash" = 0 and "copy_strategies"."withdrawn" = 0 and "copy_strategies"."realized_pnl" = 0 and "copy_strategies"."fees" = 0 and "copy_strategies"."funding" = 0)));