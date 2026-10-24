-- Suggested minimum budget, heavy leaders (Stage 2026-10-24): one tracked leader (a market maker; market makers stay
-- tracked) had 806,756 fills in 30 days and the hourly refresh's 100-leader statements never finished under the
-- 15 s statement timeout. The refresh now reads one leader a statement, and above SUGGESTED_BUDGET_FILLS_CAP fills
-- in the window it computes the median over the newest cap fills only; `sampled` marks such a row
-- (apps/api/src/traders/suggested-budget.repository.ts). Small table (one row a leader), rewritten hourly:
-- a constant default needs no table rewrite.
-- Rollback: ALTER TABLE "trader_suggested_budgets" DROP COLUMN "sampled" (the previous release never reads it).
ALTER TABLE "trader_suggested_budgets" ADD COLUMN "sampled" boolean DEFAULT false NOT NULL;
