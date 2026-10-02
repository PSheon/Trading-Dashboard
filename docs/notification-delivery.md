# Durable notification delivery

Migrations `0007_notification_outbox` and `0008_action_evaluation_context` must run before starting this API version.
They add tables and an evaluation-context column; it does not enqueue old actions or send historical messages.
Apply the migration once using the deployment migration job. Local verification
uses the isolated test DB only; no production migration has been performed.

Recent live actions and their `action_outbox` intent commit in the same existing
address-lock transaction. Backfill and corrections do not enqueue alerts.
The in-memory event keeps low latency; the five-second outbox poll recovers missed
events. Rule evaluation serializes by chain/address/coin and commits cooldown
reservations, recipient delivery intents and evaluation completion together.
The action intent captures available equity for percentage rules; replay uses this
snapshot even when watcher memory is empty. Unknown equity retains the flat
threshold fallback. Favorite cooldown is durable across restarts; rule cooldown also consults legacy
alert rows for compatibility.

`notification_outbox` has one row per action/recipient. Alerts start as pending;
a claimed sender updates the same rows after the attempt. Atomic claims use a
five-minute lease; abandoned leases can be reclaimed. Evaluation/delivery each
get at most five claims before terminal failure. Each delivery claim retains the
existing bounded Telegram retry policy; Retry-After over one minute is persisted
as a future available time instead of keeping a worker asleep. Failed transient
attempts retry after at least one minute. Completed and terminal failed rows are
retained for investigation; finished rows are deleted after 30 days by the retention job ([data-retention.md](data-retention.md)).

Before every external attempt, including retries, check current account status, Telegram destination, favorite
subscription/filters or admin role, and the global notification switch. Removing
or disabling the original Telegram destination does not redirect an old message
to a new chat. Messages include their original action timestamp, so delayed
recovery does not present an old trade as current.

`GET /admin/outbox` requires `admin.access` and returns aggregate counts by status
for evaluations and deliveries, without payloads or Telegram identifiers.
Investigate terminal failures before an operator resets a row to pending. Do not
blindly reset sent rows. There is no public retry endpoint in this batch.

Delivery is **at least once**, not exactly once: Telegram can accept a message
before the process records success. A crash in that gap can cause one duplicate
when a lease is reclaimed. Database uniqueness prevents duplicate intents, not
that external side-effect ambiguity. No transaction is held across Telegram HTTP.
Single-replica watcher/poller deployment remains the supported topology.

## Throughput, pacing and age (review findings 49 and 51, 2026-10-03)

- **Drain.** `NotifyService.deliverAction` reads the due deliveries in batches
  of 100 and sends 8 at a time until none is due (or 30 s have passed; the next
  call continues). It was 20 rows for the action at once, then 20 every 5 s:
  45 s for 200 recipients. The evaluation drain reads 200 actions a pass (was 20).
- **Pacing.** The limit is Telegram's, enforced in one place:
  `TelegramHttpClient.sendMessage` waits for a slot of 25 messages a second in
  all (Telegram allows about 30) and at least 1 s after the last message to the
  same chat. Alerts, system messages and bot replies share it. 200 recipients
  take about 8 s. A 429 is still honoured through `retry_after`.
- **Due by the database clock.** A row is due when `available_at <= now()` in
  Postgres, not against a JS time: a row committed a moment ago could be a few
  hundred microseconds "in the future" for a millisecond clock, and the drain
  right after the commit then found nothing.
- **Age cut-off.** An evaluation whose action is older than 10 minutes
  (`ALERT_MAX_AGE_MS`) is closed as `expired` without alerting, on the event
  path and on replay; a delivery queued more than 10 minutes ago is marked
  failed with reason `expired` and not sent. Actions older than
  `maxActionAgeSeconds` (120 s) were already never queued; this covers a queue
  that sat (worker down, a restored backup, long Telegram refusals).
