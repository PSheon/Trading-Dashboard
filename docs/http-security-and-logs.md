# HTTP security and request logs

API requests receive an x-request-id before route handling. Valid supplied IDs
are 1–64 alphanumeric/underscore/hyphen characters; others are replaced. The
same ID accompanies response metadata and AsyncLocalStorage-backed JSON logs.
Admitted background jobs detach from HTTP context. Request completion logs
contain method, route template, status and duration, without query strings,
request bodies or headers. JSON serialization escapes newlines, bounds nested
objects and handles cycles/errors/BigInt. Configured secrets, sensitive object
keys, Bearer tokens and credential-bearing URLs are redacted. Notification
suppression logs no longer contain rendered messages or recipient chat IDs.
Signing-material keys (signature, private key, mnemonic and seed phrase) and
raw body/header containers are also redacted. Next development request logging,
browser-console forwarding and server-action argument logging are disabled:
OAuth callback query parameters must not enter terminal access logs.

Production bootstrap uses StructuredLogger for Nest and service loggers. This
is source-level local verification, not proof that the hosting log drain,
retention policy or alert rules are configured. Keep access to logs restricted.

API responses disable x-powered-by and set nosniff, DENY framing, no-referrer,
no-store and a restrictive JSON-API CSP. Production/staging also emit HSTS
without preload or includeSubDomains. The Next app sets nosniff, DENY framing,
referrer policy, permission policy and CSP frame/base/object restrictions.
For pages, `src/proxy.ts` overrides the baseline policy with a fresh script
nonce, strict-dynamic, and explicit Privy/Hyperliquid/Arbitrum connect/frame
origins (`src/lib/csp.ts`). Production omits unsafe-eval; the root layout's
locale cookie makes pages dynamic, as nonce policies require. No COOP rule
that would break authentication popups is added.

API_CORS_ORIGINS is an exact comma-separated HTTP(S) origin allowlist. Empty
permits no cross-origin browser reads; the same-origin Next proxy needs no
entry. Paths, credentials and wildcard values fail startup. Allowed browsers
can send Authorization, X-API-Contract and X-Request-ID and read Retry-After and
response metadata. Cookie credentials are not enabled. Public API data remains
reachable by ordinary HTTP clients; CORS is not authorization. Existing direct
browser integrations must configure their origin before deploying this change.

Frontend production fixture exclusion now covers webpack as well as Turbopack;
this matters because webpack is the documented validation fallback in this
sandbox. The default Turbopack build remains separately tracked.
