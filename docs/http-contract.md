# HTTP boundary

All ordinary JSON endpoints now return the canonical envelope by default:
`{success:true,statusCode,message,data,meta:{requestId,path,timestamp,pagination?}}`.
Failures return
`{success:false,statusCode,message,error:{code,details?,fields?},meta}`.
`timestamp` is an ISO UTC timestamp; request IDs remain sanitized and correlated.
HTTP statuses retain their meaning. Validation fields use dotted paths
(`rows.0.address`); business codes and error details remain stable.

**Breaking change:** raw JSON success/error bodies for clients without
`X-API-Contract: 1` have been removed. Update external clients to unwrap `data`
and read `error.code` / `error.details` before deploying this release.
The header is now only a response format marker; omitting it or sending an
unknown value cannot select another format. Responses no longer vary by it.
The browser requires a valid envelope, timestamp and matching HTTP status for
ordinary successful JSON responses. Its defensive error parser can still read
raw operational/gateway errors, but the application server emits one error format.

Health/readiness, HEAD, 204, SSE and StreamableFile success responses remain raw.
Only the two actual health paths keep raw operational errors; unknown health
subpaths still receive canonical 404 envelopes. Errors before an SSE stream starts
are canonical JSON. Internal errors never expose SQL, stacks or bound values.
The same-origin proxy normalizes its own failures even without a request header.

`GET /traders` and `GET /admin/users` add
`meta.pagination:{type:"offset",limit,offset,total,hasMore}`.
`GET /traders/:address/trades` adds
`{type:"cursor",limit,total,nextCursor,hasMore}`.
The existing `data.total`, `data.items` and `data.nextCursor` are retained.
Array feeds do not fabricate totals or pagination guarantees.

`wire-contracts.ts` defines every endpoint's response allowlist. The interceptor
serializes Date to ISO strings and bigint to decimal strings, validates the DTO
and strips undeclared object fields. Precision-sensitive persisted amounts stay
strings. Explicit dynamic objects (`paramsJson`, payloadJson, raw upstream fill
records and keyed sparkline results) retain their declared extensibility. These
fields are deliberately not automatic persistence-row spreading. Owned alert
payloads can include delivery details; the existing recipient scope still applies.
New DB columns do not enter registered responses automatically. Health/readiness and non-JSON exceptions above stay unchanged.
Unregistered ordinary JSON handlers fail closed; CI prevents any production
controller route from lacking a registry entry.

Browser requests and fixtures validate against the same registry before data
enters the UI. Malformed payloads raise `invalid_response`, never silently pass as
TypeScript types. Browser domain aliases use JsonWire so Date/BigInt are not
assumed after JSON transport. Domain/request schemas remain separate; Zod query
coercion does not weaken output validation.

Streaming routes (`GET /actions/stream`, `text/event-stream`) have no JSON body
(`response: z.never()`); their registry entry lists each SSE event name with the
schema of its `data:`, and the server validates every event before writing it.
`action` carries the action id as the SSE `id:` (the `Last-Event-ID` resume
cursor); `update` (a corrected row) carries none; `reset` means the replay was
truncated. Errors before the stream starts (400/401/403/429/503) use the normal
error bodies above.

Favorites streams reauthenticate the original bearer token against verified JWT
expiry and current persisted user state before replay/live delivery batches and
on each 15s heartbeat. A missing, expired or disabled identity, a changed user,
or an authorization error closes the stream; checks time out after 5s. An idle
revoked stream is thus closed within a heartbeat plus the check timeout, subject
to event-loop scheduling. This checks local persisted disablement and token
validity; it does not claim immediate remote Privy session revocation detection.
Clients reconnect using their current token and resume cursor.

Initial favorites/replay setup has a 10s deadline. Each subscriber's UTF-8 frame
queue plus HTTP writable buffer is capped at 1 MiB, including the next frame.
Overflow or setup timeout closes the stream and releases its slot; queued frames
are cleared and late lookup results cannot write to the closed response. Checks
and delivery drain per subscriber so blocked private authorization cannot stall
public delivery. Database work already in flight remains subject to the database
driver/statement deadlines; ending a stream is not a SQL cancellation claim.

Controller inputs use native class DTOs and the global Nest ValidationPipe.
`@ApiProperty` / `@ApiPropertyOptional` describe those same runtime classes;
`@ApiDoc` supplies operation summaries without granting authentication or permissions.
Swagger reads native body/query/path DTOs and the explicit SSE resume header.
Security requirements and permission/role extensions derive from actual guard metadata,
including method overrides. The shared wire registry still owns response schemas.

The complete [OpenAPI document](openapi.json) now includes request DTOs, parameter
bounds/defaults/nullability, nested settings, responses, HTTP statuses, security
requirements and SSE event schemas. OpenAPI 3.1 preserves chart tuple positions
with JSON Schema `prefixItems`. Unknown body DTO keys are documented as rejected;
dynamic rule/import maps remain explicitly extensible. Conditional requirements
(settings revision preconditions, paired action cursors, rule-specific parameters,
import semantics) are described alongside the inputs; these are not all expressible
as standalone field constraints.

**Local documentation:** run the API with `NODE_ENV=development` (or `test`), then
open `/docs/`; raw JSON is at `/docs-json`. Staging/production do not mount
the UI, JSON or assets. API authorization is unchanged. Swagger does not persist
bearer tokens, and its CSP permits only local scripts and API requests.
The UI requires inline styles; that allowance is limited to the docs path in local
environments. No API-wide CSP relaxation or remote validator is enabled.

Build shared and API, then run:
`node scripts/http-contract-docs.mjs`, `node scripts/openapi.mjs`.
CI checks artifact freshness, native DTO documentation coverage and structural
OpenAPI validity. The export creates controllers with inert providers: no AppModule,
database connection, env file, background job or network listener is started.
Compiled bootstrap tests compare the running app's document to the offline export.

The Zod 3 response adapter remains pinned to `zod-to-json-schema@3.25.2`.
It now belongs to API dependencies so local runtime Swagger and offline export share
one generator. It is deprecated upstream; replace it during a Zod 4 migration.
Production does not invoke/load the document builder. Native request DTO metadata
does not depend on that adapter.

Swagger metadata and class-validator constraints remain two declarations.
Representative constraint tests plus a property-coverage gate detect omissions;
changes to validation still require reviewing the corresponding documentation.
The document is not a generated browser client; that remains a separate integration.

Implementation follows DonutMe's transform/filter split while retaining Zod and
Express. Framework boundaries checked against [Nest interceptors](https://docs.nestjs.com/interceptors)
and [exception filters](https://docs.nestjs.com/exception-filters).

## Trader profile degradation

`GET /traders/:address` includes optional `dataQuality` metadata: each source's
availability, observation `asOf`, `maxAgeMs` and response-time `stale` value.
Clients must continue aging timestamps while displayed; the web checks every
30 seconds. These timestamps describe the REST snapshot's observations, not
subsequent WebSocket updates. `fetchedAt` is only the profile assembly time.

A failed/timed-out individual perp dex, staking, leaderboard metadata or recorded
analytics source does not discard other successful data. Unknown `accountValue`,
`perpEquity`, `marginUsed`, `withdrawable`, `longNotional`, `shortNotional` and
`stakedValue` are null, never fabricated zero. Position rows may be a subset;
`dataQuality.partial` and per-source statuses must accompany their presentation.
Deploy nullable-aware clients before the API. Partial responses cache/retry for
5 seconds; complete responses retain the 60-second profile cache. Optional source
work has a 4-second response deadline; underlying shared fetches retain their
existing lifecycle and may populate a source cache later.

Dex discovery, account mode, spot balances/valuation and identity/tracking remain
required. A required-source failure retains HTTP error semantics, while the web
still renders independently loaded portfolio history. The web keeps partial REST
snapshots unchanged by numerical socket overlays until a complete refresh arrives.


## Trader round-trip analytics

`GET /traders/:address/analytics?window=all|30d|7d|1d` and
`GET /traders/:address/trades?status=all|closed|open&limit&cursor` are public,
registered DTO routes using the default envelope. Cursor
validation rejects unrepresentable dates/int64 IDs before invoking the service.
Coverage includes `fundingFrom` and `fundingThrough` as nullable ISO timestamps;
funding values can be partial beyond that interval. `computedAt` is the fill
analysis time and is not advanced merely by funding work. Cold computations
may return 503 with Retry-After while a bounded background job continues.
See [definitions and release order](trade-analytics.md).

## Trader page tabs (訂單 / TWAP / 轉帳)

`GET /traders/:address/orders`, `/twap` and `/transfers` are public DTO routes
that read Hyperliquid through the request budgeter at the page's fills rank and
answer 503 busy with Retry-After after 12 s, like the other trader-page reads.

| Route | Hyperliquid calls (weight) | Cache |
| --- | --- | --- |
| `/orders` | `frontendOpenOrders` per dex, 20 each: the main dex (spot orders included), plus every HIP-3 dex for a unified / portfolio-margin account, or, for a standard account, the dexes where it holds margin or a position (found with `clearinghouseState`, 2 each) | 30 s |
| `/twap` | `twapHistory` (20 + 1 per 20 items); the latest `userTwapSliceFills` (shared with the fills tab) only when a TWAP is running | 60 s |
| `/transfers` | `userNonFundingLedgerUpdates` over the last 90 days (20 + 1 per 20 items); a full 2,000-item page skips ahead to the newest 500, at most 3 calls, and sets `truncated` | 5 min |

The profile's spot balances carry `hold` (available = total − hold) and its
positions `marginUsed`, `fundingSinceOpen` and `returnOnEquity`; fills carry
`startPosition` and `liquidation` and include spot fills. All are additive.

Admin settings mutations additionally require per-section revision preconditions;
see [admin-settings.md](admin-settings.md) for 428/409 handling and rollout limits.

Request validation now runs through class DTOs and a global Nest ValidationPipe;
unknown input fields fail with 400. See [nest-http-pipeline.md](nest-http-pipeline.md).

## Public status and the admin heartbeat (review finding 36)

`GET /health` (public, raw, cached for a second) answers
`{ "status": "ok" | "degraded", "feedConnected": boolean, "now": ISO time }`:
`degraded` when the trade feed is not fully connected, 503 when the api can't
reach the worker. It carries nothing else. The request budget and its
consumers, queue depths, `dryRun`, discovery ages, the addresses whose fills
are missing and the archive ingest's figures were all in it before; they are
operational detail and now come from:

- `GET /admin/system/heartbeat` (`admin.access`, so admins and read-only
  operators): the whole heartbeat, enveloped, `no-store`. In the api role it is
  the worker's. `/admin/system` reads it in combined mode and reads the worker
  sample of `GET /admin/system/overview` in split deployments.
- the worker's own `/health` and `/health/monitor`, on its private port.

`/health/ready` is unchanged (`{ "ready": true }` or 503).
