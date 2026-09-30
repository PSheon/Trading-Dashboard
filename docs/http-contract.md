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

Controller inputs use native class DTOs and the global Nest ValidationPipe;
domain refinements remain in their use cases. The registry supplies
[route documentation](http-routes.md) and [OpenAPI response schemas](openapi-responses.json).
Regenerate with `node scripts/http-contract-docs.mjs` and `node scripts/openapi.mjs`
after building shared; CI checks both artifacts. The OpenAPI artifact covers
responses, statuses, access descriptions and SSE event schemas. It deliberately
does **not** claim complete request schemas or generated-client readiness.
Request DTO/OpenAPI integration and Swagger UI remain tracked follow-up work.

The build-time converter is pinned to `zod-to-json-schema@3.25.2` for the current
Zod 3 runtime schemas. The converter is deprecated upstream; replace it with
native generation when migrating those schemas to Zod 4. It is not a production
API dependency.

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

Admin settings mutations additionally require per-section revision preconditions;
see [admin-settings.md](admin-settings.md) for 428/409 handling and rollout limits.

Request validation now runs through class DTOs and a global Nest ValidationPipe;
unknown input fields fail with 400. See [nest-http-pipeline.md](nest-http-pipeline.md).
