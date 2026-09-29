ALTER TABLE "fills" DROP CONSTRAINT "fills_chain_tid_pk";--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_chain_address_tid_pk" PRIMARY KEY("chain","address","tid");