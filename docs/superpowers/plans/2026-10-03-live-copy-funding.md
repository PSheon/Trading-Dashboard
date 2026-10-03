# Strategy Funding Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for native implementation in this session. Preserve the user's authorization and review the final diff independently.

**Goal:** Deliver recoverable testnet strategy funding and continue toward the full Copydog acceptance matrix.

**Architecture:** Owner-bound PostgreSQL operations, exact browser-signed usdSend, single-attempt exchange submission, explorer plus recipient-ledger reconciliation. Funding remains separate from paper strategy accounting.

**Tech Stack:** NestJS, Drizzle/PostgreSQL, Zod, viem, installed Hyperliquid SDK, Next.js/React Query, Privy.

**Spec:** `docs/superpowers/specs/2026-10-03-live-copy-funding.md`

## Global Constraints

- Preserve existing dev changes and never convert paper funds into real assets.
- No assistant-initiated real wallet creation, consent, signing, transfers or trades.
- Never persist signatures, private keys or access tokens.
- Mainnet funding stays disabled until the complete live lifecycle is verified.
- API, UI, persistence and recovery must all exist before this flow is reported delivered.

## Review Focus

- Different operations in separate tabs cannot reserve the same source nonce or release an attempted transfer.
- A transfer ledger match without the original action nonce cannot credit an operation.
- Owner disablement or account identity changes during remote reads prevent submission.
- Delayed replies after logout cannot submit a previous user's signature or overwrite current-user state.
- The pending transfer and actual received amount remain visible even when the wallet SDK is unavailable.

## Task 1: Persist funding operations and single-attempt API

Files: `packages/shared/src/copy-funding-contracts.ts`, `packages/shared/src/copy-funding-signing.ts`, `packages/shared/src/schema/db.ts`, copy funding repository/service/controller/DTO, and `apps/api/test/copy-funding.spec.ts`.

Interfaces: `reserve(userId, accountId, {amount,idempotencyKey})`, `claim(userId,id)`, `submit(userId,id,signature)`, `cancel(userId,id)`, `reconcile(userId,id)`; all results are owner-safe shared wire contracts.

- [x] Write isolated DB and independent-signature tests, run them before implementation, and observe failure.
- [x] Implement persistence, exact typed data and CAS submission; share source exclusion/nonce maximum with main withdrawals.
- [x] Validate explorer transaction plus recipient ledger before credit; test missing, ambiguous and mismatched evidence.
- [x] Run `node scripts/test-api-isolated.mjs test/copy-funding.spec.ts test/wallet-withdrawals.spec.ts` with the existing private local test administrator environment. Expected: all pass; only randomly created test databases are changed.

## Task 2: Owner funding UI and recovery

Files: funding hooks/operation runner, execution-wallet funding card, existing settings component, 11 locale catalogs, web tests and browser fixtures.

Interfaces: consume Task 1 wire contracts; `runCopyFunding` signs only prepared operations and never retries an attempted unknown/accepted operation.

- [x] Write session-switch, restart/recovery, explicit signing and immutable-intent tests; observe failure.
- [x] Implement testnet-only confirmation and funding state/history; pending recovery works without Privy signing.
- [x] Run focused web tests and browser desktop/mobile verification. Expected: correct state and no unintended signing or horizontal overflow.

## Task 3: Release verification and remaining acceptance tracking

- [x] Generate migration and HTTP/OpenAPI artifacts, verify schema freshness and repository boundaries.
- [x] Run complete isolated API tests, web tests, typecheck, lint and builds; fix failures before committing.
- [ ] Review final diff, record verified and externally unverified scope, commit and push dev.
- [ ] Continue with agent lifecycle and live runtime dependencies from the spec; funding delivery alone does not complete the overall objective.
