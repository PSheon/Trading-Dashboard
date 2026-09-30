# DonutMe frontend architecture comparison

Reviewed 2026-09-30 against Trading-Dashboard `1057132` and the local DonutMe-Frontend-Core source. This is a source-level architecture review with focused query lifecycle fixes, not a claim of complete CopyDog feature parity or measured performance gains.

## Adopted patterns and concrete changes

| Area | DonutMe reference | Trading-Dashboard finding and outcome |
| --- | --- | --- |
| Cache identity | `src/lib/query-keys.ts` | Keys were repeated in query hooks, admin views, mutation invalidation and SSE. `apps/web/src/lib/query-keys.ts` now owns those identities. Existing tuple shapes are preserved, including the SSE list query string at index 1. |
| Retry policy | `src/lib/query-config.ts` | Trader overrides retried 401/403 and other 4xx three times despite the session default rejecting retries. `query-policy.ts` now consistently rejects 4xx and AbortError, retries ordinary transient failures once, and retains 12/120 retries for explicit 503 busy responses. Busy delays retain Retry-After with the existing 30-second cap. |
| Cancellation | Query function/transport boundary | Most reads ignored TanStack Query's signal. All current query-function HTTP reads now forward it, including infinite trades, admin data and authenticated endpoints. Cancellation reaches fetch; session-change cancellation remains an additional boundary. This does not cancel a submitted mutation or guarantee the backend stops work already accepted. |
| Reused queries | `src/lib/api-fetcher.ts`, query keys/config | Home featured profiles duplicated the detail request and omitted busy recovery. Both now use `traderProfileOptions`; each observer retains its own freshness/polling schedule. Concurrent consumers share one request. |
| Feature hooks | `src/hooks/use-api-keys.ts`, `src/services/api-keys.ts` | Admin users mixed pagination serialization, fetching, mutation and invalidation with the view. `lib/admin-users.ts` owns those server concerns; the view owns search debounce, selected filters, page and rendering. Successful changes invalidate every cached user filter/page. |
| Bootstrap documentation | `src/providers/query-provider.tsx` | Updated `AppProviders` JSDoc: translations → auth → identity-scoped query cache. Removed the obsolete claim that browsers do not use WebSockets. |

## Keep these existing strengths

1. **Server/client boundary:** App Router layouts and route metadata stay on the server; interactive views and subscriptions stay client-side. Do not move authenticated live data into shared server caches without an explicit identity model.
2. **Transport and contracts:** `lib/api.ts` owns tokens, same-origin proxy requests, envelopes, errors and runtime wire validation; `lib/contracts.ts` exposes JSON-safe types. Do not copy DonutMe service fallbacks that accept raw-or-wrapped payloads or silently substitute empty arrays for invalid responses.
3. **Session isolation:** `auth.tsx` and `session-queries.tsx` retire the previous identity's cache and descendant state. Keep this stronger boundary rather than copying a general application-wide QueryClient. Existing startup deduplication and StrictMode behavior remain required regressions.
4. **Authorization:** Admin shell permissions gate UI rendering; the API remains the authorization authority. Query keys and hidden controls are not security boundaries.
5. **Live updates:** Action SSE merges cached first-page lists; trader WebSockets reduce REST frequency. Key factories retain these contracts rather than introducing a new cache schema.
6. **Presentation:** Existing feature component folders, shared UI primitives, i18n and formatting utilities already separate reusable presentation. This change preserves the visual design and Claude's concurrent trader rail work.

## Minimal layering convention

- `app/`: route composition, metadata, server-only proxy.
- `components/<feature>/`: rendering and local interaction state. A small one-off query may remain inline.
- `lib/<feature>.ts` hooks or `<feature>-query-options.ts`: shared requests, server-state lifecycle and mutation invalidation when there is real reuse or orchestration (currently alerts, admin users, profile options and trading queries).
- `lib/query-keys.ts`, `query-policy.ts`: shared cache identities and retry semantics. Endpoint-specific polling stays beside its query.
- `lib/api.ts`, `contracts.ts`: HTTP/authentication/envelope/validation boundary.

New shared helpers should document the invariant they protect, not restate their signatures. Do not add frontend repositories, injectable service classes, a universal query factory or a second source of API contracts. `lib/queries.ts` remains the trading hook collection; split it by feature only when independent consumers justify the extra files.

## Deliberate differences and remaining work

- Most simple admin queries remain next to their views. They now share keys, cancellation and default retry policy; moving each through a one-line service and hook would add little value.
- Keep the current 10-second global polling fallback and endpoint overrides. A future polling audit should measure request volume before changing freshness guarantees. No performance improvement is claimed without measurements.
- All 4xx, including 429, currently stop query retries to match the existing session policy; periodic refetch/manual retry can recover. Dedicated rate-limit recovery would require an explicit policy and tests. SSE already has its own 429 reconnect policy.
- SSR prefetch/hydration, broad bundle splitting and a generic service layer were not introduced: authenticated live queries require a scoped design, and this review found no measurement justifying those additions.
- CopyDog follow-trading execution and the separately documented backend feature gaps are unaffected by this frontend refactor. Fixture E2E does not prove real Privy login, Hyperliquid or Telegram behavior.

## Validation

Updated mobile browser tests to use the existing radio-segment navigation and open Insights before checking rail content; desktop tab semantics remain separately tested.

Regression coverage includes permanent/transient/busy retry budgets, actual fetch cancellation, shared profile request deduplication, all-page admin invalidation, existing SSE merging and session/StrictMode tests. The execution ledger records final suite/build/browser outcomes for the integrated revision.
