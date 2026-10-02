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
Retry-After through the normal error envelope. Counters have at most
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

The Next forwarder relays the last syntactically valid received forwarded-IP
entry. That value is trustworthy only if the hosting edge sanitizes it. Default
Express trust remains disabled, so anonymous visitors share the forwarder's
egress allowance; authenticated visitors
have separate user windows but still share the broader ingress allowance. Edge
per-client limiting or authenticated forwarding metadata must be configured
and tested for the actual hosting topology before asserting per-visitor limits.
SSE concurrent-stream limits separately retain STREAM_TRUSTED_PROXY_HOPS
(default 0) from the live-feed feature. The hop count applies only when the
socket peer is in API_TRUSTED_PROXY_CIDRS (otherwise X-Forwarded-For is ignored
and the peer is the client), so both must be set; verify a fixed,
non-bypassable topology before enabling either. Per-client keys (rate limits,
SSE per-IP caps, the Hyperliquid page budget) count IPv4 per address and IPv6
per /64. At capacity the limiter evicts expired keys, then admits new clients
through a shared per-category overflow bucket (10x the limit) rather than
refusing them. `/health` and `/health/ready` have their own per-client bucket
(120/min) and answer from a one-second cache. No production proxy setting or edge policy was changed by this source update.

## Railway (Stage): web → api over the private network

Path: browser → Railway edge → `web` (Next) → private network → `api`.
The `web` service reaches `api` at its `*.railway.internal` name, so the
api's socket peer is the web service's private address, an IPv6 address in
`fd12::/16` that changes with every deployment. With nothing set, the api
trusts no forwarded address and every visitor is that one peer: one read
window (300/min) for all anonymous visitors, one set of 8 live-feed streams,
one Hyperliquid page-budget share, one slot set for cold analytics.

Set on the **api** service:

| Variable | Value | Why |
| --- | --- | --- |
| `API_TRUSTED_PROXY_CIDRS` | `fd12::/16` | Only a peer on the private network (the web service) may name the client. A request through the api's own public domain arrives from Railway's edge, which is not in this range, so its forwarded header is ignored. |
| `STREAM_TRUSTED_PROXY_HOPS` | `1` | The web forwarder replaces `X-Forwarded-For` with a single entry, so the client is one hop before the peer. |

Set on the **web** service:

| Variable | Value | Why |
| --- | --- | --- |
| `CLIENT_IP_HEADER` | `x-real-ip` | Railway's edge reports the visitor's address in `X-Real-IP` (its documented request headers have no `X-Forwarded-For`). Unset, the forwarder takes the last `X-Forwarded-For` entry, which on Railway may be whatever the client sent. |

What the code does with them: `/api/hl/*` and the server-side reads behind
the trader page's title, its link-preview image and the share card all send
`X-Forwarded-For: <that address>` and nothing else from the client's
forwarding headers. The image routes also keep their own window of 30
images per client and minute (429 with `Retry-After`), since each uncached
card is four api reads.

Before relying on it, confirm two facts that the code cannot see:

1. The private range. In a shell on the web service
   (`railway ssh --service web --environment staging`):
   `node -e "require('dns').lookup('api.railway.internal',{all:true},(e,a)=>console.log(a))"`.
   Only `fd12:…` addresses → the value above is complete. If a `10.…`
   address is listed too (newer environments resolve both families), add
   that IPv4 range to `API_TRUSTED_PROXY_CIDRS`, comma-separated.
2. That the edge overwrites `X-Real-IP`. It is the last step of the test
   below.

Test from two client addresses (two networks, e.g. a laptop and a phone on
mobile data; call them A and B), after setting the variables and
redeploying both services:

1. A, 310 anonymous reads within a minute:
   `for i in $(seq 1 310); do curl -s -o /dev/null -w "%{http_code}\n" https://<web>/api/hl/discover/home; done | sort | uniq -c`
   → 300 × `200`, then `429` with `Retry-After`.
2. B, during the same minute: `curl -i https://<web>/api/hl/discover/home`
   → `200`. Before the change B gets `429` too.
3. A opens 9 live-feed streams
   (`curl -N https://<web>/api/hl/actions/stream &` nine times): the ninth
   is `429`; B can still open one.
4. Spoofing, from A while it is limited:
   `curl -i -H "X-Real-IP: 198.51.100.1" -H "X-Forwarded-For: 198.51.100.1" https://<web>/api/hl/discover/home`
   → still `429`. A `200` here means the edge passes a client's header
   through and `CLIENT_IP_HEADER` names the wrong header: unset the api
   variables again until that is resolved.
5. The api's own public domain, if it has one, from A with
   `-H "X-Forwarded-For: 198.51.100.1"`: the limit does not move to the
   spoofed address (the edge is not a trusted peer).
6. Images: A requests `https://<web>/trader/<address>/share-image` 31 times
   in a minute → the 31st is `429`; B gets `200`.

The approach follows DonutMe's verified-user tracker and adapter-resolved IP
boundary, adapted to Express and this single-process runtime. References:
[Nest rate limiting](https://docs.nestjs.com/security/rate-limiting) and
[Express proxy trust](https://expressjs.com/en/guide/behind-proxies/).
