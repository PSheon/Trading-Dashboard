The live boundary is separate from the paper executor and does not book fills, cash,
fees, or release reservations. `LiveOrderExecutor` consumes an already risk-approved
`LiveOrderIntent`, an authoritative `WalletAuthorizationService`, a durable
`LiveExecutionJournal`, a mandatory `LiveExecutionGate`, and a `HyperliquidLiveTransport` whose network is fixed at
construction. It builds perpetual limit/IOC orders using exact, indexed market
identity. The concrete Privy order adapter permits testnet delegated-agent
signing only. Vault/subaccount signing, spot orders, cancellation and the complete
live worker remain outside this executor. Principal wallet preparation, agent
approval and funding have separate owner-consent workflows in `CopyModule`.

`WalletAuthorizationService` now requires `HyperliquidAgentApprovalVerifier` (wired
through `CopyModule`) as well as local consent. Dedicated delegated signers are
checked against a fresh, unique exact-address `extraAgents` listing queried on
the grant's actual account and fixed network. Missing, expired, malformed,
ambiguous or unavailable approval fails closed; no positive result is cached.
An unnamed/default agent absent from that listing is unsupported. Self signing
instead requires a fresh `userRole=user` response. These checks do not establish
Privy ownership, the account's supported master role, risk approval or consent:
those remain mandatory verified-provisioning and final risk-gate inputs.

The actual SDK signing and exchange POST boundaries each acquire new approval
evidence after their risk gate, reread local consent after the exchange read,
then revalidate both expiries and the five-second evidence window synchronously
after the final lease check. Intermediate preparation checks read only local
consent, but still refuse an unconfigured verifier. A standard delegated order
therefore makes two uncached approval reads, not repeated role queries at every
intermediate check. The shared budget charges `extraAgents` 20 and `userRole` 60;
funding explorer receipts separately cost 40. Slow/budget-starved observations
are refused rather than timestamped as fresh. These are bounded observations,
not atomic cancellation: an owner can revoke after the final local/remote read,
or a lock can fail just after its last check. Exchange/provider fencing would
be needed to eliminate that outgoing-request race.

`PrivyOrderSigner` requires a boundary-aware `PrivyOrderSigningClient`, implemented
by `BoundaryPrivyOrderSigningClient` using the installed SDK. A configured callback
supplies the worker's P-256 request-authorization key; credentials and keys remain
outside the journal. The key is not the agent EVM private key or owner authority.
The request-scoped adapter disables retries and SDK logging, limits complete
responses to 64 KiB and ten seconds, and cancels streams on timeout. Its exact
RPC fetch hook rechecks the original risk permit after SDK request preparation
awaits, immediately before transport. Before signing, it checks the local grant and actual
Privy wallet's address, chain, owner quorum and archive state. The grant's
`privyOwnerId` is a Privy owner quorum ID, not an application user ID or a user DID.
The signer accepts only the exact prepared order's phantom-agent hash and the
expected network/domain, then verifies the returned EVM signature against the
bound signer and original hash. `@nktkas/hyperliquid@0.33.3` supplies canonicalization,
msgpack hashing and EIP-712 signing; this code does not reimplement cryptography.

`PostgresLiveExecutionJournal` implements durable network/account/cloid uniqueness,
immutable prepared payloads, transition checks and session advisory locks across
replicas. It allocates nonces atomically per network/signer using
`max(now, previous+1)`, without holding a transaction open during HTTP.
`PostgresWalletAuthorizationSource` loads grants only through the current enabled
owner, Privy identity, ready owned master, active setup, unretired agent wallet
and strategy ownership. Detached legacy grants cannot authorize an order.
Verified provisioning must populate those grants, and every authorization mutation
must increment its version. The application now provides dedicated user-owned
master wallet preparation and owner-scoped local grant revocation through
`CopyWalletService`. Master accounts are persisted separately in
`copy_execution_accounts`; preparing one never creates an agent, grant or exchange
approval and never switches a paper strategy to live. `CopyAgentService` now
provides verified user-owned agent provisioning, explicit principal approval,
durable unknown recovery and verified grant rotation. `CopyAccountModeService`
separately prepares a standard-mode operation for a dormant dedicated testnet
master: exact owner consent, all-venue absence evidence and one persisted
attempt precede the principal POST. An accepted response and supported current
mode are separate states; disabled/null legacy evidence remains unproven.
No workflow activates live copying; the live worker remains unimplemented.

Atomic source preparation now captures the generation baseline, canonical source
leg, immutable sizing envelope, journal, provenance and nonce on the original
owner/account/source PostgreSQL session. `LiveProviderReadEpoch` shares one
unchanged five-second set of concrete provider observations across preparation,
reservation, signing and submission. Reuse rereads current SQL authority; it
cannot restamp expired evidence or move it to another session. Actual terminal
settlement retains the complete canonical proof and digest, records follower
receipts and cash movements, releases reservations and advances proportional
reduction carry atomically. A placement acknowledgment is not that settlement.

`TestnetLiveExecutionRuntime` now composes those concrete dependencies for one
immutable routing request. It shares the original PostgreSQL session and private
provider epoch from preparation through reservation, signing and submission.
Historical attempted keys reconcile without new admission, signatures or nonces.
The factory is unregistered while worker recovery and stop handling remain
incomplete. Its offline integration tests do not establish an actual
owner-funded testnet order.

Fixed opening sizes include the worst admitted buy limit in the signed USD
budget and floor at the exchange lot. A lower sell limit cannot enlarge the
mid-price quantity. A lot below the exchange minimum is denied; the system never
rounds upward or silently increases the owner's per-trade amount.

Registered public and wallet clients now share durable outbound REST and WS
admission through `HyperliquidGlobalTransport` and `PostgresHyperliquidQuota`.
Every service/replica using the same provider egress must use the same explicit
`HYPERLIQUID_EGRESS_KEY` and quota database. Financial POST admission happens
before final synchronous proof checks; a private finite permit is rechecked
after costly validation immediately before native transport. Missing global
configuration fails closed. Minute charges are never refunded for an uncertain
send. Private cancellation can release a socket reservation only before its
connect permit has ever been dispatched. Unknown native closure cannot be
reclaimed by inventing a clean close or changing an egress alias.
The installed provider also closes without a WebSocket close frame. An original
private socket can release transport capacity after matching durable unsubscribe
ACKs and an authenticated remote TLS EOF followed by an error-free native close,
with no local reset or termination. The actual diagnostic remains 1006; retained
transport proof never releases financial reservations or refunds minute charges.

Public profiles, orders and TWAP use bounded real WS snapshots. Persistent public
connections renew their leases and meter heartbeats, preserve original snapshot
times and require matching unsubscribe acknowledgments. Missing profile venues
remain unknown, so aggregate equity is nullable. Public reporting evidence is
not a dedicated-account risk permit. The actual market watcher loads the full
indexed metadata in two REST requests and meters its socket subscriptions.

These concrete boundaries do not complete the mainnet product. The financial
worker, durable cancel/stop/flat/sweep operations, generation-renewal execution,
HIP-3 effective-fee admission, collected-fee allocation and treasury payouts still
require implementation and separate actual owner-funded acceptance. Runtime
configuration continues to reject `COPY_TRADING_MODE=testnet|live`.

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

Offline tests replace HTTP while exercising the installed Privy request
authorization and Hyperliquid hashing/signing adapters. Ephemeral fixture keys
verify exact EVM signature recovery and rejection of foreign signers/hashes.
They do not establish real Privy user consent or an actual exchange fill.

Reference: [Hyperliquid signing](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing),
[rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits),
[nonce rules](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets),
[exchange orders](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint),
[order status](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint),
[SDK custom signers](https://github.com/nktkas/hyperliquid/blob/main/docs/signing.md),
[Privy typed data](https://docs.privy.io/wallets/using-wallets/ethereum/sign-typed-data).


## Final execution checks and remaining integration

The executor, Privy signer, and exchange submission boundary require an explicit
`LiveExecutionGate`. Missing gate, phase-bound permit or lease implementations deny execution; there
is no allow-all production default. The gate receives a detached copy of the
exact intent and durable order, with phase `sign` or `submit`. Implementations
must throw when any authoritative input is missing, stale, revoked, or denied.
The signer checks again after its remote Privy wallet and signing-context reads;
the transport checks immediately before starting the POST. An earlier approval
or a callback that only checks a cached boolean does not satisfy this contract.

`PostgresLiveExecutionJournal` supplies a lease tied to its original advisory-lock
session. `assertHeld()` checks that session's exact granted advisory lock without
reacquiring it, and session `error` or normal `end` permanently invalidates the lease. The
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

1. **Authoritative risk adapter:** `assessLiveAccountRisk` and
   `AccountRiskExecutionGate` now validate detached, phase-bound evidence and
   recheck its age after the computation. `PostgresLiveRiskScope` holds matching
   policy/platform shared locks, the existing user writer lock and an account
   session lock, with original-scope callbacks invalidated before unlock. A
   concrete DB proof producer and durable live reservation are implemented and
   composed by the unregistered testnet factory. They load current ownership,
   controls, policy, immutable consent, collateral, all-venue positions, orders
   and fresh market observations; uncertain coverage or stale evidence denies
   execution. Connect only after restart and stop handling are complete.
2. **Wallet/grant lifecycle:** connect the implemented master, agent and mode
   workflows to the live admission path. All identity, revocation, retirement
   and quarantine writers must follow its serialization protocol. Verified
   grants alone do not prove supported mode, funded collateral or live consent.
3. **Funding operations:** durable deposit/withdraw/sweep intents and reservations,
   chain/exchange confirmation, fee/minimum/collateral validation and restart-safe
   reconciliation of unknown outcomes. Activation follows confirmed funding.
4. **Follower accounting:** actual fills/fees/funding ingestion, immutable receipt
   deduplication, conflicts/quarantine, worker scan recovery and owner statements
   are implemented. Connect them to reservation settlement, live positions and
   account equity. Journal order status alone cannot book PnL or release collateral.
5. **Worker and stop lifecycle:** connect the live executor separately from paper,
   supervise reconciliation and alerts, and implement cancel, late-fill handling,
   flat verification, then sweep. Validate restart and lease-loss scenarios on
   testnet before separately reviewing mainnet configuration.
6. **Market identity:** indexed main/named-dex mapping, persisted market identity,
   builder approval and order-status matching are implemented. All-venue account
   reads retain original DEX indices, including null slots and opaque names.
   The uncached risk provider currently proves effective fees for validator perps;
   named-dex effective fee scope remains unproven and admission is denied. Neither
   numeric asset IDs nor the Stocks UI establish trade permission.

These are integration prerequisites, not implemented production readiness. No
live/testnet execution mode has been enabled by this boundary work.

## Why the sweep back to the main wallet is not automatic (2026-10-05)

CopyDog's help says stopping a copy closes its positions and sweeps
everything back to the main wallet. Orbie closes automatically but stops at
`stop_awaiting_return_to_main_wallet` until the owner signs the return. The
missing piece is authority, not code:

- The funds sit on the copy's Hyperliquid account, whose key is a Privy
  wallet the owner alone owns (`PrivyWalletProvisioner`: owner `user_id`,
  no additional signer; provisioning verifies `additional_signers` is empty
  and the owner quorum holds exactly that user, no authorization keys).
- A transfer out of that account is a `usdSend` signed by the account
  itself. The worker's agent (API wallet) can trade and reduce but
  Hyperliquid does not let an agent transfer or withdraw funds.
- So the return is signed by the account wallet through Privy with the
  owner's live session JWT (`PrivyMasterActionSigner`, `user_jwts`) after
  the owner's main wallet signs the exact transfer (consent).

Making the sweep automatic safely needs a server signer on the account
wallet that can sign only that transfer: a Privy key quorum (the worker's
authorization key) added as an additional signer on each copy account
wallet, with a Privy policy allowing only `HyperliquidTransaction:UsdSend`
whose destination is the owner's main wallet (and nothing else), added with
the owner's consent when the copy account is created, and the provisioning
checks above relaxed to expect exactly that signer and policy. Until then
the portfolio shows "Return everything" as soon as the stop is flat.
