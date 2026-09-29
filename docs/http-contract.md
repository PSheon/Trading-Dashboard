# HTTP boundary

The browser sends `X-API-Contract: 1`. For this version, successful responses are
`{success:true,statusCode,message,data,meta:{requestId,path}}`; failures are
`{success:false,statusCode,message,error:{code,details?,fields?},meta}`. HTTP statuses
retain their meaning. Fields use dotted paths (`rows.0.address`). Business codes
such as `alert_limit`, `telegram_not_linked`, and `telegram_not_configured` remain
stable. Generic codes include validation_error, unauthorized, forbidden,
not_found, conflict, rate_limited, unavailable, bad_gateway and internal_error.
Internal errors never return exception stacks, SQL or bound values. Unique/FK
conflicts alone are mapped to 409; other DB/program errors stay 500.

Clients without the header keep legacy response bodies, validated and stripped by
the same response DTO allowlist as negotiated clients. Unknown versions also
receive legacy bodies and no version acknowledgement. New clients accept a
validated legacy DTO while rolling out; a response acknowledging version 1 must
have a valid envelope. Keep this compatibility until all external callers have
migrated and an announced API version removes it; no silent removal is planned.
Health/readiness, HEAD, 204 and StreamableFile responses remain raw. Negotiated
responses advertise X-API-Contract; Vary includes it. Same-origin proxy forwards
contract/request IDs and Retry-After, rejects redirects, cancels upstream on
client disconnect and normalizes its own gateway failures.

`wire-contracts.ts` defines every endpoint's response allowlist. The interceptor
serializes Date to ISO strings and bigint to decimal strings, validates the DTO
and strips undeclared object fields. Precision-sensitive persisted amounts stay
strings. Explicit dynamic objects (`paramsJson`, payloadJson, raw upstream fill
records and keyed sparkline results) retain their declared extensibility. These
fields are deliberately not automatic persistence-row spreading. Owned alert
payloads can include delivery details; the existing recipient scope still applies.
New DB columns do not enter either registered legacy or version 1 responses
automatically. Health/readiness and non-JSON exceptions above stay unchanged.
Unregistered legacy handlers retain their existing behavior; CI prevents any
production controller route from lacking a registry entry.

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

Controller input parsing uses common/http/validation.ts; domain refinements such
as rule-specific parameters and import row semantics remain in their use cases.
The shared route list supplies [generated route documentation](http-routes.md).
A test compares controller routes to the registry; adding an endpoint requires a
response schema and docs regeneration. The existing request schemas and access
matrix complement the route document; this is not an OpenAPI document.

Implementation follows DonutMe's transform/filter split while retaining Zod and
Express. Framework boundaries checked against [Nest interceptors](https://docs.nestjs.com/interceptors)
and [exception filters](https://docs.nestjs.com/exception-filters).
