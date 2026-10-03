# Strategy funding and live copy continuation

The user has authorized completing the remaining Copydog gaps, committing to dev, and preserving Claude's work. The next independently verifiable flow is testnet funding from the signed-in user's main Hyperliquid account to that user's verified dedicated strategy account. This extends the approved copy runtime design; it does not convert paper balances to real collateral.

## Funding contract

An immutable operation binds owner, strategy account, network, source, destination, canonical six-decimal USDC amount, client idempotency key and server nonce. States are prepared, unknown, accepted, credited, rejected and cancelled. Accepted means exchange acknowledgement; credited requires positive transaction and recipient ledger evidence. Prepared and proven unattempted unknown operations can be cancelled. Attempted unknown/accepted operations remain pending and are never submitted again.

The browser signs only the persisted usdSend intent with its current main wallet. The API verifies EIP-712 independently, checks wallet ownership again immediately before an attempt, persists a compare-and-set attempt marker, and performs one bounded POST. No signature, private key or access token is persisted or logged. Funding and main withdrawals share source-account serialization and nonce allocation. A response loss never grants permission to resend.

Internal-transfer ledger entries lack a nonce. Reconciliation therefore checks the candidate hash with the fixed network's explorer txDetails, including exact usdSend action time, source, destination, chain and amount, then confirms the same hash on the recipient ledger. A balance increase alone and an empty bounded ledger prove neither success nor failure. Actual fee and credited amount are stored separately; multiple matching transactions or inconsistent evidence remain pending. Testnet funding is clearly identified in the UI. Mainnet funding remains unavailable until the live lifecycle is wired and verified.

Receipt scans allow the documented one-day forward nonce tolerance. Each cycle freezes its end time, subdivides capped time windows, and persists bounded hash progress and up to two positive receipts. Revisions reject stale scan writers. Only one receipt after a complete cycle confirms credit; no receipt starts a new lookup cycle, and ambiguous evidence stays pending. A provider cap containing at least 2,000 records within a single millisecond cannot establish complete coverage through the time-based API and remains unresolved rather than being treated as failure or permission to resend. Background confirmation continues for submitted transfers even when new copying or the owner is disabled.

## Verification

Use real isolated PostgreSQL for owner isolation, idempotency conflicts, cross-replica attempt claims, pending-operation constraints, cancellation races, source nonce uniqueness across funding and withdrawals, and immutable identity. Independent signing vectors pin EIP-712 shape. Fault tests cover stale wallet identity, disabled owner, rejected/ambiguous responses, explorer nonce mismatch, fees, missing recipient evidence and restart recovery. UI tests cover explicit signing, immutable confirmations, session changes, recovery without a wallet SDK and error states. External Privy/Hyperliquid acceptance is a separate uncompleted verification until actually performed.

## Remaining objective

Follow funding with agent consent/policy/approval, final risk adapter, actual fill/fee/funding accounting, live worker, cancellation/late-fill/flat verification/sweep, complete market identities, then data and peripheral product parity. Native distribution, external provider configuration and private Copydog algorithms must be recorded with their actual evidence and dependencies; they cannot be marked complete by mock tests.
