The live boundary is separate from the paper executor and does not book fills, cash,
fees, or release reservations. `LiveOrderExecutor` consumes an already risk-approved
`LiveOrderIntent`, an authoritative `WalletAuthorizationService`, a durable
`LiveExecutionJournal`, a mandatory `LiveExecutionGate`, and a `HyperliquidLiveTransport` whose network is fixed at
construction. It supports standard perpetual limit/IOC orders on master accounts
using an approved agent or the account's own signer. Vault/subaccount signing,
spot/HIP-3 orders, transfers, agent approval, cancellation, and wallet provisioning
are not implemented by this boundary.

`PrivyOrderSigner` uses the installed Privy Node SDK. A configured callback supplies
Privy's authorization context; credentials and signing keys must remain outside
the journal. Before signing, it checks the current local grant and the actual
Privy wallet's address, chain, owner quorum and archive state. The grant's
`privyOwnerId` is a Privy owner quorum ID, not an application user ID or a user DID.
The signer accepts only the exact prepared order's phantom-agent hash and the
expected network/domain. `@nktkas/hyperliquid@0.33.3` supplies canonicalization,
msgpack hashing and EIP-712 signing; this code does not reimplement cryptography.

`PostgresLiveExecutionJournal` implements durable network/account/cloid uniqueness,
immutable prepared payloads, transition checks and session advisory locks across
replicas. It allocates nonces atomically per network/signer using
`max(now, previous+1)`, without holding a transaction open during HTTP.
`PostgresWalletAuthorizationSource` loads local grants and rejects disabled users.
Verified provisioning must populate those grants, and every authorization mutation
must increment its version. The application does not yet provide that provisioning
or connect this boundary to its paper strategy worker.

The state flow is `prepared -> submitting -> resting | filled | partial |
cancelled | rejected`. Exceptions after the POST begins produce `unknown`.
Recovered `submitting`, `unknown`, and `resting` rows only query `orderStatus`
using the actual trading account and original cloid. Missing or malformed
evidence never authorizes another submission. A prepared signing failure can be
retried before its 60-second exchange expiry; an expired prepared order is
rejected before submission. Operators must resolve prolonged unknown orders
from exchange evidence, not reset them to prepared. Resting partial fills remain
resting; terminal IOC partial fills are partial. Reconciliation may return a
terminal state without average price or fees: fetch/dedupe actual fills by
exchange order/trade ID before accounting, and never fabricate those values.

Local strategy scope does not narrow an exchange agent's account-wide authority.
Before activation, establish dedicated account ownership or robust strategy lot
accounting/reduction clamps, verify exchange approval independently, and wire
current pause/reduce-only/risk controls at the final execution boundary. This
directory does not enable live trading in an application module or environment.

Offline tests inject Privy and HTTP responses while exercising the actual installed
Hyperliquid hashing/signing adapter. They verify payloads and fault handling;
they do not validate signatures with Privy or execute an exchange order.

Reference: [Hyperliquid signing](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing),
[nonce rules](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets),
[exchange orders](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint),
[order status](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint),
[SDK custom signers](https://github.com/nktkas/hyperliquid/blob/main/docs/signing.md),
[Privy typed data](https://docs.privy.io/wallets/using-wallets/ethereum/sign-typed-data).


## Final execution checks and remaining integration

The executor, Privy signer, and exchange submission boundary require an explicit
`LiveExecutionGate`. Missing gate or lease implementations deny execution; there
is no allow-all production default. The gate receives a detached copy of the
exact intent and durable order, with phase `sign` or `submit`. Implementations
must throw when any authoritative input is missing, stale, revoked, or denied.
The signer checks again after its remote Privy wallet and signing-context reads;
the transport checks immediately before starting the POST. An earlier approval
or a callback that only checks a cached boolean does not satisfy this contract.

`PostgresLiveExecutionJournal` supplies a lease tied to its original advisory-lock
session. `assertHeld()` checks that session's exact granted advisory lock without
reacquiring it, and a session error permanently invalidates the lease. The
executor checks before durable state changes, signing, submission and saving
exchange evidence. A lost lease after preparing/submitting leaves recovery to
the next owner; the old worker does not overwrite the journal. This is not an
exchange-side fencing token: a connection can fail just after the final check.
The durable `submitting` state, fixed cloid and no blind resubmission remain
necessary to resolve that race.

The signed action, nonce and expiry must equal the persisted order. Extra signed
request fields (such as a different account/vault) are refused. Inputs are copied
across asynchronous boundaries. A transport `LiveSubmissionBlockedError` proves
no POST started and records rejection; HTTP/response errors remain ambiguous.

Before connecting a live worker, implement and verify all of these dependencies:

1. **Authoritative risk adapter:** load the strategy and owner/platform controls,
   current policy and revision, exclusive reservation, funded execution-account
   collateral and positions, and fresh quote/market metadata on every final
   gate call. Enforce pause/reduce-only/stop, limits, direction and exact reduction
   ownership. Reject stale revisions or unavailable reads. Persist the approval
   and reservation linkage so a restarted worker can verify the same intent.
2. **Wallet/grant lifecycle:** verified dedicated execution-account ownership,
   Privy owner/policy binding, user consent, independently confirmed exchange-agent
   approval, expiry, revocation and rotation. Supply signing authorization without
   persisting secret material. No fabricated grants or paper balance may satisfy it.
3. **Funding operations:** durable deposit/withdraw/sweep intents and reservations,
   chain/exchange confirmation, fee/minimum/collateral validation and restart-safe
   reconciliation of unknown outcomes. Activation follows confirmed funding.
4. **Follower accounting:** ingest and dedupe actual exchange fills, fees, funding,
   balances and positions by network/account/order/trade identity. Journal order
   status alone is not enough to book PnL or release all reserved collateral.
5. **Worker and stop lifecycle:** connect the live executor separately from paper,
   supervise reconciliation and alerts, and implement cancel, late-fill handling,
   flat verification, then sweep. Validate restart and lease-loss scenarios on
   testnet before separately reviewing mainnet configuration.
6. **Market identity:** persist and verify network, account/dex scope, canonical
   coin, universe index, size precision, metadata source/version/time and delisting
   status against authoritative exchange metadata. The current intent has only
   an asset integer and caller-supplied precision; it cannot prove HIP-3 identity.
   `buildOrderAction` therefore continues to reject asset IDs >= 10000 (including
   spot and HIP-3). Add a typed authoritative mapping and include its identity in
   the durable fingerprint before widening market support; never infer permission
   from a numeric range or the presence of Stocks in the UI.

These are integration prerequisites, not implemented production readiness. No
live/testnet execution mode has been enabled by this boundary work.
