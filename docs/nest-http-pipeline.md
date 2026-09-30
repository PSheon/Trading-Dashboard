# Nest HTTP pipeline (DonutMe alignment)

The earlier schema helpers and response envelope did not constitute DonutMe-style
Nest input architecture. This migration adds actual class DTOs, class-validator /
class-transformer decorators, and a global Nest ValidationPipe. The existing shared
Zod schemas remain browser/wire contracts and internal domain validation where
needed; they are not invoked manually by HTTP controllers.

## Runtime path

Request → authentication/permission guards → global interceptor entry → global
ValidationPipe → typed controller → service/use case → feature repository / UnitOfWork
→ controller result → TransformInterceptor → wire contract → response envelope.
Exceptions flow to the existing AllExceptionsFilter. Guards intentionally run before
pipes, so an invalid unauthorized request does not bypass authorization. Busy responses
retain their existing specialized filter and Retry-After behavior.

`common/http/http.module.ts` registers `APP_PIPE` using
`config/validation/validation-pipe.factory.ts`. The module is imported by production
AppModule and HTTP test modules. No redundant bootstrap-only pipe is needed.

The pipe first rejects non-object roots (including empty arrays) before native DTO
transformation; native optional DTO validation alone is insufficient for that case.
It enables transform, whitelist, forbidNonWhitelisted and forbidUnknownValues.
Implicit conversion is disabled. Only declared input transforms convert values:
`@ToBoolean()` accepts exact true/false strings, `@ToNumber()` rejects empty/malformed
numeric inputs, `@ToLowerCase()` normalizes addresses and `@Trim()` trims import names.
`@Optional()` skips undefined only; `@Nullable()` also allows null where the contract
allows it. DTO declarations do not materialize omitted PATCH properties. Defaults
exist only where the endpoint supplies defaults, not on PATCH fields.

Nested settings use `@Type()` plus `@ValidateNested()` and object validators. Unknown
nested fields are rejected. Dynamic import column maps, rule params and quietHours
remain explicitly dynamic objects, with semantic import/rule checks retained. R1/R3
thresholds, paired feed cursors and bigint/time cursor ranges are validated as well.
The SSE resume header has a dedicated DTO, validated before opening the stream.

All body/query/path inputs in production controllers use runtime class DTO imports.
A source gate rejects interface/unknown inputs and inline request parsers; runtime
HTTP tests prove actual transformation and rejection before controller invocation.
Controller-only integration tests explicitly invoke the same pipe because ordinary
TypeScript method calls do not execute Nest decorators.

## Output and error boundaries

`@SkipTransform()` explicitly marks health/readiness and SSE. StreamableFile, HEAD,
204 and already-written responses retain their existing transport handling.
`@ResponseMessage()` supplies success-message metadata; it does not alter permissions,
HTTP status or output allowlists. The interceptor uses Reflector with handler-over-class
precedence. No decorators hide authorization inside documentation/response handling.

Output uses the existing shared response-schema registry rather than a second set of
response class DTOs: Date is serialized to ISO, bigint to exact decimal strings and
unknown output fields are stripped by the wire schema. This avoids removing the
existing protection against accidental persistence-column exposure.

Validation failures remain 400 / validation_error with dotted field paths, preserving
the browser error contract rather than adopting DonutMe's 422. Native validation error
targets and raw values are excluded. Existing envelope negotiation, business error
codes, request IDs and legacy output compatibility remain intact.

## Compatibility and maintenance

Unknown body/query/path keys now fail instead of being silently ignored. Shared
request/query schemas also use strict objects so fixtures reject unknown keys. Query numbers
must be non-empty numeric strings; repeated numeric query arrays fail. Action and user
path IDs require valid positive ranges. Clients must send only documented inputs.
Response messages on admin mutations are now specific rather than always "OK"; callers
must use status/code/data, never human-readable messages, for control flow.

Class DTO input rules and shared contracts are two declarations. `request-dto.spec.ts`
checks representative defaults/conversions against shared contracts plus rejection,
nullable/omitted PATCH and precision cases. This is a regression guard, not a proof
that all future schema edits remain equivalent; update both declarations and tests.

This batch does not add Swagger/OpenAPI generation, response class-serialization,
or new transaction policies. DonutMe's API documentation and project-specific auth
metadata are not copied blindly. Existing repository ownership and transaction locks
remain unchanged; direct DB access still present in some services is separately tracked.

Known test limitation: the source gate checks runtime imports and DTO type names,
not that each imported symbol is a class. HTTP tests and the compiled bootstrap probe
provide runtime evidence for the exercised routes; retain those tests when extending
controllers.
