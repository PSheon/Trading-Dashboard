# Optimization execution ledger

Plan/spec: `docs/copydog-gap-and-practices-review.md`; authorized order: data credibility → API/streams → scale/operations → paper-copy/execution preparation.
Baseline: 7904d39; isolated branch codex/audit-fixes. No remote deployment, real trades, production migration or external notification is authorized by this implementation run.

## Pre-flight and rulings

- Shared interfaces: API DTO → wire schemas → fixtures → web consumers must evolve together. New crowd comparison fields are optional for rolling compatibility; crowd valuation fields now allow null, so deploy the updated web consumer before the API; old clients must not receive a prior total that encourages comparisons between different cohorts.
- Ruling: Claude branch f25b29f already implements trade analytics/history/fees in the backend. Do not duplicate that unmerged backend work. Address E01 with the explicitly allowed 30-day label solution, label existing E02 gross metrics honestly, and advance independent E05 while awaiting/reviewing integration. Cost: period-selectable win rate and net/funding accounting remain pending until the new contract is integrated.
- Ruling: exposure change means marked notional difference for addresses observed at both dates, not trade flow; disclose matched/current/prior counts. Missing snapshots are unknown, not flat. Cost: partial coverage comparisons describe only the matched subset.

## Tasks

- E01: six UI rendering regressions observed RED; explicit 30d label, recorded perp round-trip source, missing-analytics state and fee/funding/history qualification now GREEN (6/6). E02 gross-label clarification only; no claim of net accounting.
- E05: matching cohorts, coin union, explicit exposure change and coverage UI completed. Review regressions additionally require null valuation/bias for missing entry or unrealized PnL, preserving position counts. DB tests and SSR rendering passed.
- E04: versioned flow-neutral method, excluded interval counts/fraction, capital floor and observed/partial/unavailable quality exposed; bilingual public methodology page added. No assertion of full history coverage.
- E06: HTTP Info runtime schemas and bounded decoded response reader implemented; malformed values, unsafe integers, unknown account modes and invalid nested referral data are rejected. WS paths remain outside this batch.
- E02/E03/E22: gross label/source clarification only; net accounting, history completeness and low-sample basis remain pending Claude integration.
- E07–E09/E16: pending.
- E10–E15/E17–E21: pending; external verification requires the actual configured environment.
- G01–G12: pending; real financial side effects require explicit separate authorization.

## Review and upstream compatibility

The required fresh branch review identified missing-PnL valuation, unknown totals rendered as zero, and official/live shape differences. Valuation findings were reproduced RED then fixed; missing amounts/bias now return null and UI renders a dash. Nullable crowd values require the updated frontend to deploy first; existing numeric-only clients need updating.

Official [spot context example](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot) omits `coin`, while a fresh public read on 2026-09-29 returned 885 contexts with zero missing identities, matching the pre-existing captured fixture. Contexts cannot safely be mapped by array index (existing live fixture is not aligned), so missing identity deliberately fails closed instead of guessing a token price. Captured live fixture compatibility is tested. This is a known incompatibility with the abbreviated published example, not a claim that every upstream variant is accepted.

The official [referral example](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-a-users-referral-information) uses one flat `tokenToState` pair; captured fixtures and a fresh public zero-address read contain nested pairs. Both are validated; the single pair is normalized to the application's nested representation. Ready/needToTrade/needToCreateCode captured fixtures pass; unknown stages fail closed.

## Verification

- API full regression: 51 files / 560 tests passed; the two subsequently added fixture compatibility regressions also pass (focused upstream suite 11/11).
- Web unit/SSR regression: 14 files / 62 tests passed.
- API and web typecheck/lint passed; final web production webpack build passed.
- Dependency compatibility: 3/3 passed; audit reports zero known advisories. Existing Privy/Farcaster optional-module warning remains tracked by E18/E20.
- Chromium fixture E2E: 6/6 passed. Production Docker image built with frozen lockfile; isolated image migration/readiness (HTTP 200)/graceful shutdown (exit 0) passed. No remote CI/deployment verification claimed.
