# Request limits and monitored favorites

The API uses bounded in-process counters for the supported single-replica
runtime. A pre-authentication IP window bounds token-verification work. After
verification, read/write/expensive windows use the persisted user ID; changing
Privy tokens or IP addresses does not create another allowance. Anonymous calls
use Express's resolved IP. Service-token calls share one service allowance.

Defaults per minute: ingress 3000, reads 300, writes 60, imports and Telegram test
sends 10. Configure positive integers with API_INGRESS_PER_MINUTE,
API_READ_PER_MINUTE, API_WRITE_PER_MINUTE and API_EXPENSIVE_PER_MINUTE. Health
probes bypass these windows. Rejected requests return 429, rate_limited and
Retry-After through the normal negotiated error envelope. Counters have at most
10000 active buckets and refuse new buckets when full instead of evicting active
limits. A restart resets counters; multiple replicas require a shared limiter
or an edge policy before scaling.

The default MAX_FAVORITES_PER_USER is 100. Additions lock the persisted user row
and count favorites in the same transaction as insertion and watch activation.
Retries of existing favorites remain idempotent at the limit. Rejections create
no leader or backfill. Lowering a limit does not remove existing favorites;
users can remove them and add again once below the limit. Alert-enabled traders
retain their separate settings quota. This bounds each account's watched
addresses, not the total across all accounts or privileged imports.

## Proxy trust

By default Express trusts no forwarded IP headers. API_TRUSTED_PROXY_CIDRS may
list explicit immediate proxy IPs/CIDRs, comma-separated. Universal /0 ranges
and boolean/hop-count shortcuts are rejected. Operators must verify every
trusted proxy sanitizes forwarded headers and the actual network path before
configuring trust. Never infer trust from a caller-supplied header.

The current Next forwarder does not forward client IP headers. Anonymous
visitors behind it therefore share its egress allowance; authenticated visitors
have separate user windows but still share the broader ingress allowance. Edge
per-client limiting or authenticated forwarding metadata must be configured
and tested for the actual hosting topology before asserting per-visitor limits.
No production proxy setting or edge policy was changed by this source update.

The approach follows DonutMe's verified-user tracker and adapter-resolved IP
boundary, adapted to Express and this single-process runtime. References:
[Nest rate limiting](https://docs.nestjs.com/security/rate-limiting) and
[Express proxy trust](https://expressjs.com/en/guide/behind-proxies/).
