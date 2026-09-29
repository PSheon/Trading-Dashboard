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

Clients without the header keep legacy response bodies. Unknown versions also
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
New DB columns do not enter version 1 responses automatically.

Browser requests and fixtures validate against the same registry before data
enters the UI. Malformed payloads raise `invalid_response`, never silently pass as
TypeScript types. Browser domain aliases use JsonWire so Date/BigInt are not
assumed after JSON transport. Domain/request schemas remain separate; Zod query
coercion does not weaken output validation.

Controller input parsing uses common/http/validation.ts; domain refinements such
as rule-specific parameters and import row semantics remain in their use cases.
The shared route list supplies [generated route documentation](http-routes.md).
A test compares controller routes to the registry; adding an endpoint requires a
response schema and docs regeneration. The existing request schemas and access
matrix complement the route document; this is not an OpenAPI document.

Implementation follows DonutMe's transform/filter split while retaining Zod and
Express. Framework boundaries checked against [Nest interceptors](https://docs.nestjs.com/interceptors)
and [exception filters](https://docs.nestjs.com/exception-filters).
